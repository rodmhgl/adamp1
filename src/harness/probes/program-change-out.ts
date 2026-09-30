import { parseProgramChange } from '../../core/program-change.js';
import { hexBytes } from '../../core/sysex.js';
import type { Probe } from '../probe-runner.js';
import { askMemory } from './memory-question.js';

export interface ProgramChangeOut {
  /** The Memory the maintainer selected, as the display showed it, when they entered one. */
  memory?: number;
  programChanges: SentProgramChange[];
}

export interface SentProgramChange {
  /** 1–16, as the unit shows it: this is report data, not wire bytes. */
  channel: number;
  externalProgramNumber: number;
  bytes: string;
}

const SELECT_MEMORY =
  'Select a different Memory on the front panel with ^ V (not in Edit mode). The harness is listening to MIDI Out.';

/**
 * The maintainer selects a Memory on the front panel while the harness listens. The
 * hypothesis under test is that the unit sends a Program Change on MIDI Out when they
 * do; the probe records each one's channel and number against the Memory selected.
 * Nothing is sent to the unit.
 */
export const programChangeOutProbe: Probe<ProgramChangeOut> = {
  name: 'program-change-out',
  kind: 'guided',
  async run({ operator, listenWhile }) {
    // MIDI real-time messages (F8–FF), such as Active Sensing, say nothing about the Memory selected.
    const received = await listenWhile((bytes) => bytes[0]! < 0xf8, () => operator.instruct(SELECT_MEMORY));
    const memory = await askMemory(operator, 'Which Memory does the display show now?');

    const programChanges: SentProgramChange[] = [];
    const others: string[] = [];
    for (const { bytes } of received) {
      const programChange = parseProgramChange(bytes);
      if (!programChange) {
        others.push(hexBytes(bytes));
        continue;
      }
      const { channel, externalProgramNumber } = programChange;
      programChanges.push({ channel: channel + 1, externalProgramNumber, bytes: hexBytes(bytes) });
    }
    const findings = [
      `After the selection, the display showed ${memory.reading}.`,
      ...programChanges.map((programChange) => describe(programChange, memory.memory)),
      ...(others.length > 0
        ? [`${others.length} other message${others.length === 1 ? '' : 's'}: ${others.join(', ')}.`]
        : []),
    ];
    const data = { ...(memory.memory !== undefined && { memory: memory.memory }), programChanges };

    if (programChanges.length === 0) {
      return {
        verdict: 'refuted',
        summary: 'The unit sent no Program Change on MIDI Out when a Memory was selected on the front panel.',
        findings,
        data,
      };
    }
    return {
      verdict: 'confirmed',
      summary: `The unit sent ${programChanges.length === 1 ? 'a Program Change' : `${programChanges.length} Program Changes`} on MIDI Out when a Memory was selected on the front panel.`,
      findings,
      data,
    };
  },
};

function describe({ channel, externalProgramNumber, bytes }: SentProgramChange, memory: number | undefined): string {
  const sent = `Program Change: External Program Number ${externalProgramNumber} on channel ${channel} (${bytes})`;
  if (memory === undefined) return `${sent}.`;
  return externalProgramNumber === memory
    ? `${sent}: the same as the Memory selected, ${memory}.`
    : `${sent}: not the Memory selected, ${memory}.`;
}
