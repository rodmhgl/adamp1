import type { MemoryImage } from '../../core/memory-image.js';
import { describeProgram, programDifferences, type Program } from '../../core/program.js';
import { programChange } from '../../core/program-change.js';
import { hexBytes, isSysEx } from '../../core/sysex.js';
import { describeFailedRead } from '../memory-image-transfer.js';
import type { Probe, ProbeContext, ProbeOutcome } from '../probe-runner.js';
import { askMemory } from './memory-question.js';
import { readWorkingRegister } from './working-register-steps.js';

export interface ProgramChangeIn {
  externalProgramNumber: number;
  /** The Memory selected before, as the display showed it. */
  memoryBefore?: number;
  /** The Memory the display showed after the Program Change. */
  displayedMemory?: number;
  /** Every Memory holding the Program the Working Register read back, when it could be read. */
  matchingMemories?: number[];
}

/** Sent unless Memory 10 is already selected, so the change shows on the display. */
const EXTERNAL_PROGRAM_NUMBER = 10;
const OTHER_EXTERNAL_PROGRAM_NUMBER = 20;

/**
 * Sends a Program Change and finds which Memory it loaded: from the display, as the
 * maintainer reads it, and from the Working Register matched against the Memory Image
 * (the session's backup, or a fresh dump). The display works even without SysEx.
 *
 * The hypothesis under test is the factory one-to-one MIDI Map (manual §4.1): External
 * Program Number n loads Memory n. A refutation can also mean the MIDI Map was changed.
 * The Program Change replaces the Working Register, so the maintainer confirms first.
 */
export const programChangeInProbe: Probe<ProgramChangeIn> = {
  name: 'program-change-in',
  kind: 'guided',
  async run(context) {
    const { wireChannel, operator, request } = context;
    const before = await askMemory(operator, 'Which Memory does the display show before the Program Change?');
    const externalProgramNumber =
      before.memory === EXTERNAL_PROGRAM_NUMBER ? OTHER_EXTERNAL_PROGRAM_NUMBER : EXTERNAL_PROGRAM_NUMBER;
    const confirmed = await operator.confirm(
      `Send a Program Change for External Program Number ${externalProgramNumber} on channel ${wireChannel + 1}? ` +
        'It loads a Memory into the Working Register, so unstored front-panel edits are lost.',
    );
    if (!confirmed) {
      return { verdict: 'inconclusive', summary: 'The maintainer declined the Program Change, so nothing was sent.', findings: [] };
    }

    // No reply is expected; waiting the timeout gives the unit time to load the Memory before the read.
    const message = programChange(wireChannel, externalProgramNumber);
    const reply = await request(message, isSysEx);
    const findings = [
      `Before the Program Change, the display showed ${before.reading}.`,
      `Sent Program Change ${hexBytes(message)}: External Program Number ${externalProgramNumber} on channel ${wireChannel + 1}.`,
      ...(reply ? [`The unit answered the Program Change with ${hexBytes(reply.bytes)}.`] : []),
    ];

    const workingRegister = await readWorkingRegister(context);
    const after = await askMemory(operator, 'Which Memory does the display show now?');
    findings.push(`After it, the display showed ${after.reading}.`);
    let matchingMemories: number[] | undefined;
    if (workingRegister.ok) {
      findings.push(`Working Register after the Program Change: ${describeProgram(workingRegister.program)}.`);
      const image = await memoryImage(context);
      if (!image.ok) findings.push(image.finding);
      else {
        matchingMemories = memoriesHolding(image.image, workingRegister.program);
        findings.push(
          matchingMemories.length === 0
            ? 'The Working Register matches no Memory.'
            : `The Working Register matches Memory ${matchingMemories.join(', ')}.`,
        );
      }
    } else {
      findings.push(workingRegister.finding);
    }
    if (before.memory !== undefined) {
      await operator.instruct(`Select Memory ${before.memory} again on the front panel to return to where you were.`);
    }

    const data: ProgramChangeIn = {
      externalProgramNumber,
      ...(before.memory !== undefined && { memoryBefore: before.memory }),
      ...(after.memory !== undefined && { displayedMemory: after.memory }),
      ...(matchingMemories && { matchingMemories }),
    };
    return { ...verdict(data), findings, data };
  },
};

function verdict({
  externalProgramNumber,
  memoryBefore,
  displayedMemory,
  matchingMemories,
}: ProgramChangeIn): Omit<ProbeOutcome<never>, 'findings'> {
  if (displayedMemory !== undefined && matchingMemories && !matchingMemories.includes(displayedMemory)) {
    return {
      verdict: 'inconclusive',
      summary: `The display (Memory ${displayedMemory}) and the Working Register disagree on which Memory was loaded.`,
    };
  }
  const loaded = displayedMemory ?? (matchingMemories?.length === 1 ? matchingMemories[0] : undefined);
  if (loaded === undefined) {
    return { verdict: 'inconclusive', summary: 'Which Memory the Program Change loaded could not be told.' };
  }
  if (loaded === memoryBefore) {
    return {
      verdict: 'inconclusive',
      summary: `The display still shows Memory ${loaded}: the unit may have ignored the Program Change (MIDI channel, OFF, or a front-panel edit).`,
    };
  }
  if (loaded === externalProgramNumber) {
    return {
      verdict: 'confirmed',
      summary: `External Program Number ${externalProgramNumber} loaded Memory ${loaded}, as the one-to-one MIDI Map says.`,
    };
  }
  return {
    verdict: 'refuted',
    summary: `External Program Number ${externalProgramNumber} loaded Memory ${loaded}, not Memory ${externalProgramNumber}: Program Change numbers may be offset, or the MIDI Map changed.`,
  };
}

/** The session's backup, or a fresh dump. */
async function memoryImage({
  backup,
  readMemoryImage,
}: ProbeContext): Promise<{ ok: true; image: MemoryImage } | { ok: false; finding: string }> {
  const saved = backup();
  if (saved) return { ok: true, image: saved.image };
  const read = await readMemoryImage();
  if (read.ok) return { ok: true, image: read.image };
  return { ok: false, finding: `The Memory Image to match the Working Register against could not be read: ${describeFailedRead(read)}` };
}

function memoriesHolding(image: MemoryImage, program: Program): number[] {
  return image.programs.flatMap((held, i) => (programDifferences(held, program).length === 0 ? [i + 1] : []));
}
