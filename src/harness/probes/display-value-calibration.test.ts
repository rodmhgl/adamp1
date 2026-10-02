import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runProbe, selectProbes } from '../probe-runner.js';
import { FileCalibrationStore } from '../calibration-store.js';
import { DONE, ScriptedOperator, type OperatorAnswer } from '../testing/scripted-operator.js';
import { SimulatedUnitPort } from '../testing/simulated-unit.js';
import { displayValueCalibrationProbe, type CalibrationTable } from './display-value-calibration.js';
import type { ParameterName } from '../../core/program.js';

// Values in unit byte order: Overdrive 1, Overdrive 2, Master Gain, Bass, Midrange, Treble,
// Presence, Effects Loop, Chorus Depth, Chorus Rate, Voicing.
const ORIGINAL = [30, 30, 10, 6, 6, 6, 6, 0, 0, 0, 1];
const BASS = 3;
const VOICING = 10;

/** What the LED shows for Bass raw 0–12 on a unit that matches the manual's table. */
const BASS_AS_MANUAL = ['-16', '-12', '-9', '-6', '-4', '-2', '0dB', '2', '4', '6', '9', '12', '16'];

describe('Display Value calibration', () => {
  let dir: string;
  let storeFile: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'adamp1-calibration-'));
    storeFile = join(dir, 'calibration.json');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  async function calibrate(parameter: ParameterName, answers: OperatorAnswer[], port = new SimulatedUnitPort({ workingRegister: [...ORIGINAL] })) {
    const operator = new ScriptedOperator(answers);
    const probe = displayValueCalibrationProbe(parameter, new FileCalibrationStore(storeFile));
    const report = await runProbe(probe, { port, channel: 1, timeoutMs: 10, operator });
    return { port, operator, report, table: report.data as CalibrationTable | undefined };
  }

  /** Every value the probe set the parameter at index `index` to, in order, from the Programs it wrote. */
  function valuesWritten(port: SimulatedUnitPort, index: number): number[] {
    // F0 0D <channel> 09 01 7F, then the Program's values.
    return port.sent.filter((message) => message[3] === 0x09).map((message) => message[6 + index]!);
  }

  it('needs the maintainer, so "all non-destructive" leaves it out', () => {
    const probe = displayValueCalibrationProbe('Bass', new FileCalibrationStore(storeFile));
    expect(probe.kind).toBe('guided');
    expect(selectProbes([probe], { allNonDestructive: true })).toEqual([]);
  });

  it('steps through every raw value, records what the LED showed, and marks where the manual disagrees', async () => {
    const shown = [...BASS_AS_MANUAL];
    shown[10] = '8';
    const { port, operator, report, table } = await calibrate('Bass', [DONE, ...shown, '']);

    expect(valuesWritten(port, BASS)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 6]);
    expect(port.workingRegister).toEqual(ORIGINAL);
    // Only the Working Register is touched: requests for it (08) and Programs addressed to it (09 … 7F).
    expect(port.sent.every((message) => message[3] === 0x08 || (message[3] === 0x09 && message[5] === 0x7f))).toBe(true);
    expect(port.loads).toBe(0);

    expect(operator.events[0]).toMatchObject({ kind: 'instruct' });
    expect(operator.events[1]).toMatchObject({ kind: 'ask', question: expect.stringMatching(/Bass.*raw 0\b/) });

    expect(report.verdict).toBe('refuted');
    expect(table?.parameter).toBe('Bass');
    expect(table?.rows).toHaveLength(13);
    expect(table?.rows[10]).toEqual({ raw: 10, displayValue: '8', manual: '9', agrees: false, readBack: 10, outOfRange: false });
    expect(table?.rows.filter(({ agrees }) => !agrees).map(({ raw }) => raw)).toEqual([10]);
    expect(report.findings.join('\n')).toMatch(/raw 10.*LED showed 8.*manual.*9/i);
  });

  it('takes "0dB", "0" and "+2" as the manual\'s 0dB and 2', async () => {
    const shown = [...BASS_AS_MANUAL];
    shown[6] = '0';
    shown[7] = '+2';
    const { table } = await calibrate('Bass', [DONE, ...shown, '']);

    expect(table?.rows.every(({ agrees }) => agrees)).toBe(true);
  });

  it('lets the maintainer skip, repeat, go back to correct, and redo an entry at the end', async () => {
    const { port, report, table } = await calibrate('Bass', [
      DONE,
      '-16', '-12', '-9',
      '-60', // typo at raw 3…
      'b', //   …noticed at raw 4: back to raw 3
      '-6', '-4', '-2', '0dB',
      's', //   skip raw 7
      'r', //   set raw 8 again before reading it
      '4', '6', '9', '12', '16',
      '7', //   at the end: redo raw 7
      '2',
      '',
    ]);

    expect(valuesWritten(port, BASS)).toEqual([0, 1, 2, 3, 4, 3, 4, 5, 6, 7, 8, 8, 9, 10, 11, 12, 7, 6]);
    expect(report.verdict).toBe('confirmed');
    expect(table?.rows.map(({ displayValue }) => displayValue)).toEqual(BASS_AS_MANUAL);
  });

  it('keeps the earlier entry when the maintainer backs out of a redo', async () => {
    const { table } = await calibrate('Bass', [DONE, ...BASS_AS_MANUAL, '7', 'b', '']);

    expect(table?.rows[7]?.displayValue).toBe('2');
  });

  it('reports skipped values as not calibrated', async () => {
    const shown: string[] = [...BASS_AS_MANUAL];
    shown[7] = 's';
    const { report, table } = await calibrate('Bass', [DONE, ...shown, '']);

    expect(report.verdict).toBe('inconclusive');
    expect(table?.rows[7]).toMatchObject({ raw: 7, displayValue: null, agrees: null });
    expect(report.findings.join('\n')).toMatch(/skipped.*raw 7/i);
  });

  it('resumes an interrupted calibration where it stopped', async () => {
    // The operator script runs out at raw 3, as if the maintainer quit.
    const first = await calibrate('Bass', [DONE, '-16', '-12', '-9']);
    expect(first.report.verdict).toBe('inconclusive');
    expect(JSON.parse(await readFile(storeFile, 'utf8'))).toMatchObject({
      Bass: [{ raw: 0, displayValue: '-16' }, { raw: 1, displayValue: '-12' }, { raw: 2, displayValue: '-9' }],
    });

    const second = await calibrate('Bass', [true, DONE, ...BASS_AS_MANUAL.slice(3), '']);

    expect(second.operator.events[0]).toMatchObject({ kind: 'confirm', question: expect.stringMatching(/resume.*raw 3/i) });
    expect(valuesWritten(second.port, BASS)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 6]);
    expect(second.report.verdict).toBe('confirmed');
    expect(second.table?.rows.map(({ displayValue }) => displayValue)).toEqual(BASS_AS_MANUAL);
  });

  it('starts over when the maintainer declines to resume', async () => {
    await calibrate('Bass', [DONE, '-16', '-12', '-9']);

    const second = await calibrate('Bass', [false, DONE, ...BASS_AS_MANUAL, '']);

    expect(valuesWritten(second.port, BASS).slice(0, 2)).toEqual([0, 1]);
    expect(second.report.verdict).toBe('confirmed');
  });

  it('keeps each parameter\'s calibration apart in the store', async () => {
    await calibrate('Bass', [DONE, ...BASS_AS_MANUAL, '']);
    const treble = await calibrate('Treble', [DONE, '-16']);

    expect(treble.operator.events[0]).toMatchObject({ kind: 'instruct' });
    const stored = JSON.parse(await readFile(storeFile, 'utf8'));
    expect(stored.Bass).toHaveLength(13);
    expect(stored.Treble).toHaveLength(1);
  });

  it('records what the unit does with Voicing values outside its range', async () => {
    // A unit that clamps Voicing to Clean Tube (2).
    const port = new SimulatedUnitPort({
      workingRegister: [...ORIGINAL],
      applies: (program) => program.map((value, i) => (i === VOICING ? Math.min(value, 2) : value)),
    });
    const { report, table } = await calibrate('Voicing', [DONE, 'S.S.', 'tUBE', 'CLEAN', 'CLEAN', 'CLEAN', 'CLEAN', ''], port);

    expect(valuesWritten(port, VOICING)).toEqual([0, 1, 2, 3, 64, 127, 1]);
    expect(table?.rows.filter(({ outOfRange }) => outOfRange)).toEqual([
      { raw: 3, displayValue: 'CLEAN', manual: null, agrees: null, readBack: 2, outOfRange: true },
      { raw: 64, displayValue: 'CLEAN', manual: null, agrees: null, readBack: 2, outOfRange: true },
      { raw: 127, displayValue: 'CLEAN', manual: null, agrees: null, readBack: 2, outOfRange: true },
    ]);
    expect(report.findings.join('\n')).toMatch(/raw 3 is outside.*read back as 2/i);
  });

  it('records what the unit does with Effects Loop values beyond In and Out', async () => {
    const { table } = await calibrate('Effects Loop', [DONE, 'Out', 'In', 'In', 'In', 'In', '']);

    expect(table?.rows.map(({ raw, outOfRange, manual, agrees }) => ({ raw, outOfRange, manual, agrees }))).toEqual([
      { raw: 0, outOfRange: false, manual: 'Out', agrees: true },
      { raw: 1, outOfRange: false, manual: 'In', agrees: true },
      // The manual's map says any non-zero value is In.
      { raw: 2, outOfRange: true, manual: 'In', agrees: true },
      { raw: 64, outOfRange: true, manual: 'In', agrees: true },
      { raw: 127, outOfRange: true, manual: 'In', agrees: true },
    ]);
  });

  it('records a value the Working Register did not read back', async () => {
    const port = new SimulatedUnitPort({
      workingRegister: [...ORIGINAL],
      applies: (program) => program.map((value, i) => (i === BASS && value === 12 ? 11 : value)),
    });
    const { report, table } = await calibrate('Bass', [DONE, ...BASS_AS_MANUAL, ''], port);

    expect(table?.rows[12]).toMatchObject({ raw: 12, readBack: 11 });
    expect(report.findings.join('\n')).toMatch(/raw 12.*read back as 11/i);
  });
});
