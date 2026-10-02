import { rawValue, withRawValue, type ParameterName, type Program } from '../../core/program.js';
import type { CalibrationEntry, CalibrationStore } from '../calibration-store.js';
import type { Probe, ProbeContext, ProbeOutcome } from '../probe-runner.js';
import { readWorkingRegister, withWorkingRegisterRestored, writeWorkingRegister } from './working-register-steps.js';

/** One raw value's row in the calibration table. */
export interface CalibrationRow {
  raw: number;
  /** What the LED showed, as typed; null when skipped. */
  displayValue: string | null;
  /** The manual's Display Value for this raw value; null where it gives none. */
  manual: string | null;
  /** Whether the LED matched the manual; null when either is missing. */
  agrees: boolean | null;
  /** The raw value the Working Register held afterwards; null when it couldn't be read. */
  readBack: number | null;
  /** Beyond the raw range the manual's tables cover, e.g. Voicing 3. */
  outOfRange: boolean;
}

export interface CalibrationTable {
  parameter: ParameterName;
  rows: CalibrationRow[];
}

/** The raw values calibration steps through for one parameter, and what the manual says each shows. */
interface Sweep {
  raws: readonly number[];
  /** The highest raw value the manual's tables cover. */
  lastInRange: number;
  manual(raw: number): string | null;
  /** How to type a reading that isn't a number. */
  hint?: string;
}

/** A sweep over raw 0 to the end of `table` (the manual's Display Values, indexed by raw value). */
function tableSweep(table: readonly string[]): Sweep {
  return { raws: table.map((_, raw) => raw), lastInRange: table.length - 1, manual: (raw) => table[raw] ?? null };
}

/** "0", ".1", …, "1.0", "10.0", as the manual prints them. */
function tenths(value: number): string {
  return value === 0 ? '0' : value.toFixed(1).replace(/^0/, '');
}

// The manual's §10.2 tables.
const OVERDRIVE = Array.from({ length: 41 }, (_, raw) =>
  tenths(raw <= 10 ? raw / 10 : raw <= 30 ? 1 + (raw - 10) * 0.2 : 5 + (raw - 30) * 0.5),
);
const MASTER_GAIN = Array.from({ length: 29 }, (_, raw) => tenths(raw <= 10 ? raw / 10 : 1 + (raw - 10) * 0.5));
const BASS_TREBLE = ['-16', '-12', '-9', '-6', '-4', '-2', '0dB', '2', '4', '6', '9', '12', '16'];
const MID_PRESENCE = ['-12', '-10', '-8', '-6', '-4', '-2', '0dB', '2', '4', '6', '8', '10', '12'];
// The manual has no Display Value table for the chorus. Its SysEx map gives 0 (off) to 100, and its
// Preset table lists Depth and Rate as those same numbers.
const CHORUS = Array.from({ length: 101 }, (_, raw) => String(raw));

const SWEEPS: Record<ParameterName, Sweep> = {
  'Overdrive 1': tableSweep(OVERDRIVE),
  'Overdrive 2': tableSweep(OVERDRIVE),
  'Master Gain': tableSweep(MASTER_GAIN),
  Bass: tableSweep(BASS_TREBLE),
  Midrange: tableSweep(MID_PRESENCE),
  Treble: tableSweep(BASS_TREBLE),
  Presence: tableSweep(MID_PRESENCE),
  // The SysEx map: "0-Out, non-zero-In". Values past 1 show how the unit treats the rest.
  'Effects Loop': { raws: [0, 1, 2, 64, 127], lastInRange: 1, manual: (raw) => (raw === 0 ? 'Out' : 'In'), hint: 'Type In or Out.' },
  'Chorus Depth': tableSweep(CHORUS),
  'Chorus Rate': tableSweep(CHORUS),
  // The SysEx map: "0-S.S., 1-Dist., 2-Clean". Values past 2 show how the unit treats the rest.
  Voicing: {
    raws: [0, 1, 2, 3, 64, 127],
    lastInRange: 2,
    manual: (raw) => ['S.S.', 'Dist', 'Clean'][raw] ?? null,
    hint: 'Type S.S., Dist or Clean, as the display and the voicing LEDs show it.',
  },
};

type StepResult = 'next' | 'back';

/**
 * Guided Display Value calibration of one parameter. It sets the parameter to each raw value
 * in turn through the Working Register, reads it back, and asks the maintainer what the LED
 * shows, recording each answer in `store` at once so an interrupted run resumes where it
 * stopped. The maintainer can skip, repeat or go back to an entry, and redo any entry at the
 * end. The result is a table of raw value → Display Value, with every disagreement with the
 * manual's tables marked. Only the Working Register is written, and the Program that was
 * sounding is written back afterwards.
 *
 * The hypothesis under test is the manual's table: "confirmed" means the LED agreed at every raw value.
 */
export function displayValueCalibrationProbe(parameter: ParameterName, store: CalibrationStore): Probe<CalibrationTable> {
  return {
    name: 'display-value-calibration',
    kind: 'guided',
    run: (context) => withWorkingRegisterRestored(context, (original) => calibrate(context, original, parameter, store)),
  };
}

async function calibrate(
  context: ProbeContext,
  original: Program,
  parameter: ParameterName,
  store: CalibrationStore,
): Promise<ProbeOutcome<CalibrationTable>> {
  const { operator } = context;
  const sweep = SWEEPS[parameter];
  const findings: string[] = [];
  let entries = store.load(parameter).filter(({ raw }) => sweep.raws.includes(raw));
  const firstMissing = () => {
    const index = sweep.raws.findIndex((raw) => !entries.some((entry) => entry.raw === raw));
    return index === -1 ? sweep.raws.length : index;
  };

  if (entries.length > 0) {
    const next = sweep.raws[firstMissing()];
    const question =
      next === undefined
        ? `${parameter} is already calibrated at all ${sweep.raws.length} raw values. Keep those entries, to review or redo some? No starts over.`
        : `Resume calibrating ${parameter} at raw ${next} (${entries.length} of ${sweep.raws.length} values done)? No starts over.`;
    if (!(await operator.confirm(question))) {
      entries = [];
      store.save(parameter, entries);
    }
  }
  await operator.instruct(
    `Calibrating ${parameter}: the harness sets it to each raw value in turn, from ${sweep.raws[0]} to ${sweep.raws.at(-1)}, ` +
      'through the Working Register; no Memory is written. Turn your amplifier down first: some values may be loud. ' +
      `For each value, press EDIT, then the ${parameter} button, read the display, and press EDIT again to leave Edit mode ` +
      'without changes: the unit ignores MIDI during an edit.' +
      (sweep.hint ? ` ${sweep.hint}` : ''),
  );

  function record(entry: CalibrationEntry): void {
    entries = [...entries.filter(({ raw }) => raw !== entry.raw), entry].sort(
      (a, b) => sweep.raws.indexOf(a.raw) - sweep.raws.indexOf(b.raw),
    );
    store.save(parameter, entries);
  }

  /** Sets the parameter to `raw` and resolves with the value read back, or null. */
  async function set(raw: number): Promise<number | null> {
    findings.push(...(await writeWorkingRegister(context, withRawValue(original, parameter, raw))));
    const read = await readWorkingRegister(context);
    return read.ok ? rawValue(read.program, parameter) : null;
  }

  /** One raw value: set it and ask for the reading until the maintainer gives one, skips or goes back. */
  async function step(raw: number, redoing: boolean): Promise<StepResult> {
    let readBack = await set(raw);
    const outside = raw > sweep.lastInRange ? ", outside the manual's range" : '';
    const commands = redoing ? 's or b keeps the earlier entry, r sets it again' : 's skip, r set it again, b back';
    for (;;) {
      const answer = (await operator.ask(`${parameter} is set to raw ${raw}${outside}. What does the display show? (${commands})`)).trim();
      const command = answer.toLowerCase();
      if (answer === '') continue;
      if (command === 'r' || command === 'repeat') {
        readBack = await set(raw);
      } else if (redoing && ['s', 'skip', 'b', 'back'].includes(command)) {
        return 'next';
      } else if (command === 's' || command === 'skip') {
        record({ raw, displayValue: null, readBack });
        return 'next';
      } else if (command === 'b' || command === 'back') {
        return 'back';
      } else {
        record({ raw, displayValue: answer, readBack });
        return 'next';
      }
    }
  }

  for (let i = firstMissing(); i < sweep.raws.length; ) {
    i = (await step(sweep.raws[i]!, false)) === 'back' ? Math.max(0, i - 1) : i + 1;
  }

  for (;;) {
    const rows = tableRows(sweep, entries);
    const disagreements = rows.filter(({ agrees }) => agrees === false).map(({ raw }) => raw);
    const skipped = rows.filter(({ displayValue }) => displayValue === null).map(({ raw }) => raw);
    const notes = [
      ...(disagreements.length > 0 ? [`the LED disagrees with the manual at raw ${disagreements.join(', ')}`] : []),
      ...(skipped.length > 0 ? [`skipped: raw ${skipped.join(', ')}`] : []),
    ];
    const answer = (
      await operator.ask(
        `${parameter} is calibrated${notes.length > 0 ? ` (${notes.join('; ')})` : ''}. ` +
          'Type a raw value to redo its entry, or press Enter to finish',
        '',
      )
    ).trim();
    if (answer === '') break;
    const raw = Number(answer);
    if (!sweep.raws.includes(raw)) {
      operator.warn(`${answer} is not one of the raw values calibrated for ${parameter}: ${sweep.raws.join(', ')}.`);
      continue;
    }
    await step(raw, true);
  }

  return outcome(parameter, sweep, tableRows(sweep, entries), findings);
}

function tableRows(sweep: Sweep, entries: readonly CalibrationEntry[]): CalibrationRow[] {
  return sweep.raws.map((raw) => {
    const entry = entries.find((candidate) => candidate.raw === raw);
    const displayValue = entry?.displayValue ?? null;
    const manual = sweep.manual(raw);
    return {
      raw,
      displayValue,
      manual,
      agrees: displayValue === null || manual === null ? null : sameDisplayValue(displayValue, manual),
      readBack: entry?.readBack ?? null,
      outOfRange: raw > sweep.lastInRange,
    };
  });
}

/**
 * Whether a typed reading is the manual's Display Value, allowing for how each is written:
 * "0dB" and "0", "+2" and "2", ".1" and "0.1", "2.2." and "2.2"; "S.S." and "ss"; any case.
 */
function sameDisplayValue(shown: string, manual: string): boolean {
  const normalise = (text: string) =>
    text
      .trim()
      .toLowerCase()
      .replace(/\s*db$/, '')
      .replace(/\.$/, '');
  const [a, b] = [normalise(shown), normalise(manual)];
  const [numberA, numberB] = [Number(a), Number(b)];
  if (a !== '' && b !== '' && Number.isFinite(numberA) && Number.isFinite(numberB)) return numberA === numberB;
  return a.replace(/[.\s]/g, '') === b.replace(/[.\s]/g, '');
}

function outcome(parameter: ParameterName, sweep: Sweep, rows: CalibrationRow[], writeFindings: string[]): ProbeOutcome<CalibrationTable> {
  const findings = [...writeFindings];
  for (const { raw, displayValue, manual, agrees, readBack, outOfRange } of rows) {
    const shown = displayValue ?? '(skipped)';
    if (outOfRange) {
      findings.push(
        `Raw ${raw} is outside the manual's range (${sweep.raws[0]}–${sweep.lastInRange}): it read back as ` +
          `${readBack ?? '(unreadable)'}, and the LED showed ${shown}${manual === null ? '' : `; the manual's map says ${manual}`}.`,
      );
    } else if (agrees === false) {
      findings.push(`Raw ${raw}: the LED showed ${shown}; the manual's table says ${manual}.`);
    }
    if (!outOfRange && readBack !== null && readBack !== raw) findings.push(`Raw ${raw} read back as ${readBack}.`);
  }
  const unreadable = rows.filter(({ readBack }) => readBack === null).length;
  if (unreadable > 0) findings.push(`${unreadable} of ${rows.length} values could not be read back from the Working Register.`);
  const skipped = rows.filter(({ displayValue }) => displayValue === null).map(({ raw }) => raw);
  if (skipped.length > 0) findings.push(`Skipped, so not calibrated: raw ${skipped.join(', ')}.`);

  const data = { parameter, rows };
  const disagreements = rows.filter(({ agrees }) => agrees === false).length;
  if (disagreements > 0) {
    return {
      verdict: 'refuted',
      summary: `The LED disagrees with the manual for ${parameter} at ${disagreements} of ${rows.length} raw values.`,
      findings,
      data,
    };
  }
  if (skipped.length > 0) {
    return {
      verdict: 'inconclusive',
      summary: `The LED agrees with the manual for ${parameter} wherever it was read, but ${skipped.length} of ${rows.length} raw values were skipped.`,
      findings,
      data,
    };
  }
  return {
    verdict: 'confirmed',
    summary: `The LED agrees with the manual for ${parameter} at every raw value it gives a Display Value for.`,
    findings,
    data,
  };
}
