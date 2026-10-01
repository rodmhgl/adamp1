import { memoryImageDifferences, type MemoryImage } from '../../core/memory-image.js';
import { describeProgram, programDifferences, withRawValue, type Program } from '../../core/program.js';
import { hex, hexBytes } from '../../core/sysex.js';
import { describeFailedRead, describeMemoryDifferences } from '../memory-image-transfer.js';
import { MemoryWriteRefused, type Probe, type ProbeContext, type ProbeOutcome } from '../probe-runner.js';
import { readWorkingRegister, withWorkingRegisterRestored } from './working-register-steps.js';
import { WRITE_TEST_PROGRAM } from './working-register-write.js';

/** The Memory each attempt means to write. Memory 2 keeps both addresses (01, 02) clear of 00 and 7F. */
export const DIRECT_WRITE_MEMORY = 2;

export type MemoryNumbering = '0-based' | '1-based';

export interface DirectWriteAttempt {
  numbering: MemoryNumbering;
  /** The address byte sent in place of 7F. */
  address: number;
  program: readonly number[];
  /** Every Memory (1–128) that changed against the dump before the attempt. */
  changedMemories: number[];
  /** Whether the target Memory, and only it, now holds the Program sent. */
  wroteTarget: boolean;
  /** Whether the Working Register held the Program sent afterwards; absent when it could not be read. */
  landedInWorkingRegister?: boolean;
  /** The ADA SysEx the unit answered the write with, if any. */
  reply?: number[];
}

export interface DirectMemoryWriteResult {
  targetMemory: number;
  attempts: DirectWriteAttempt[];
  /** The numberings whose address wrote the target Memory. */
  numberingsThatWroteTarget: MemoryNumbering[];
}

const NUMBERINGS: readonly { numbering: MemoryNumbering; address: number }[] = [
  { numbering: '0-based', address: DIRECT_WRITE_MEMORY - 1 },
  { numbering: '1-based', address: DIRECT_WRITE_MEMORY },
];

/** Overdrive values tried for a Program no Memory holds; modest, and 2,500 pairs outnumber the 128 Memories. */
const OVERDRIVE_CHOICES = 50;

/**
 * Sends a Program with the Working Register set command (09) addressed to Memory 2, once
 * as 0-based (01) and once as 1-based (02), and dumps the Memory Image after each to see
 * which Memory changed, then reads the Working Register in case the unit ignored the
 * address. Each Program sent is one no Memory and not the Working Register holds, so
 * wherever it lands shows. The Program that was sounding is written back, and the runner
 * then loads the backup back. The verdict tests the claim that one Memory can be written
 * directly: a numbering that writes Memory 2 alone confirms it, and no Memory changing
 * refutes it.
 */
export const directMemoryWriteProbe: Probe<DirectMemoryWriteResult> = {
  name: 'direct-memory-write',
  kind: 'writes-memories',
  run: (context) => withWorkingRegisterRestored(context, (sounding) => writeEachNumbering(context, sounding)),
};

async function writeEachNumbering(context: ProbeContext, sounding: Program): Promise<ProbeOutcome<DirectMemoryWriteResult>> {
  const { backup, writeProgramToAddress, readMemoryImage, timeoutMs } = context;
  let before = backup()!.image;
  const attempts: DirectWriteAttempt[] = [];
  const findings: string[] = [];
  const result = (): DirectMemoryWriteResult => ({
    targetMemory: DIRECT_WRITE_MEMORY,
    attempts,
    numberingsThatWroteTarget: attempts.filter(({ wroteTarget }) => wroteTarget).map(({ numbering }) => numbering),
  });

  for (const { numbering, address } of NUMBERINGS) {
    const program = programNoMemoryHolds(before, sounding);
    let answer;
    try {
      answer = await writeProgramToAddress(address, program);
    } catch (error) {
      // A write refused after the first leaves the earlier attempts' evidence in the report.
      if (!(error instanceof MemoryWriteRefused) || attempts.length === 0) throw error;
      return { verdict: 'inconclusive', summary: error.message, findings: [...findings, ...error.findings], data: result() };
    }
    const sent = `${numbering}: sent ${describeProgram(program)} to address ${hex(address)}, meaning Memory ${DIRECT_WRITE_MEMORY}`;
    const replyFindings = answer.reply ? answer.findings : [`No reply within ${timeoutMs} ms of the write to address ${hex(address)}.`];

    const read = await readMemoryImage();
    if (!read.ok) {
      return {
        verdict: 'inconclusive',
        summary: `The ${numbering} write was sent, but the Memory Image could not be dumped to see which Memory changed.`,
        findings: [...findings, `${sent}.`, ...replyFindings, describeFailedRead(read)],
        data: result(),
      };
    }

    const changes = memoryImageDifferences(before, read.image);
    const changedMemories = changes.map(({ memory }) => memory);
    const holdsProgram = (memory: number) => programDifferences(program, read.image.programs[memory - 1]!).length === 0;
    const wroteTarget = changedMemories.length === 1 && changedMemories[0] === DIRECT_WRITE_MEMORY && holdsProgram(DIRECT_WRITE_MEMORY);
    const workingRegister = await readWorkingRegister(context);
    const landedInWorkingRegister = workingRegister.ok ? programDifferences(program, workingRegister.program).length === 0 : undefined;
    attempts.push({
      numbering,
      address,
      program: program.raw,
      changedMemories,
      wroteTarget,
      ...(landedInWorkingRegister !== undefined && { landedInWorkingRegister }),
      ...(answer.reply && { reply: [...answer.reply.bytes] }),
    });

    if (changes.length === 0) findings.push(`${sent}; no Memory changed.`);
    for (const change of changes) {
      findings.push(
        holdsProgram(change.memory)
          ? `${sent}; Memory ${change.memory} now holds the Program sent.`
          : `${sent}; Memory ${change.memory} changed, but not to the Program sent.`,
        ...describeMemoryDifferences([change], 'was'),
      );
    }
    if (!workingRegister.ok) findings.push(`The Working Register could not be read after the write: ${workingRegister.finding}`);
    else if (landedInWorkingRegister) findings.push('The Working Register now holds the Program sent.');
    findings.push(...replyFindings);
    before = read.image;
  }

  const data = result();
  const [wrote] = data.numberingsThatWroteTarget;
  if (wrote) {
    const { address } = NUMBERINGS.find(({ numbering }) => numbering === wrote)!;
    return {
      verdict: 'confirmed',
      summary: `One Memory can be written directly, with ${wrote} Memory numbering: address ${hex(address)} wrote Memory ${DIRECT_WRITE_MEMORY}.`,
      findings,
      data,
    };
  }
  if (attempts.every(({ changedMemories }) => changedMemories.length === 0)) {
    const replies = attempts.flatMap(({ reply }) => (reply ? [hexBytes(reply)] : []));
    return {
      verdict: 'refuted',
      summary:
        `No Memory changed with either numbering: command 09 addressed to Memory ${DIRECT_WRITE_MEMORY} (01 or 02) wrote nothing` +
        (attempts.some(({ landedInWorkingRegister }) => landedInWorkingRegister) ? '; the Program went to the Working Register instead' : '') +
        (replies.length > 0 ? `; the unit answered ${replies.join(', ')}` : '') +
        '.',
      findings,
      data,
    };
  }
  return {
    verdict: 'inconclusive',
    summary: `Memories changed, but neither numbering wrote the Program sent to Memory ${DIRECT_WRITE_MEMORY} alone.`,
    findings,
    data,
  };
}

/**
 * The test Program with Overdrive 1 and 2 varied until it matches no Memory in `image`
 * and not the `sounding` Program, so a write to any Memory or the Working Register shows.
 */
function programNoMemoryHolds(image: MemoryImage, sounding: Program): Program {
  const base: Program = { raw: WRITE_TEST_PROGRAM };
  for (let overdrive1 = 0; overdrive1 < OVERDRIVE_CHOICES; overdrive1++) {
    for (let overdrive2 = 0; overdrive2 < OVERDRIVE_CHOICES; overdrive2++) {
      const candidate = withRawValue(withRawValue(base, 'Overdrive 1', overdrive1), 'Overdrive 2', overdrive2);
      if ([...image.programs, sounding].every((program) => programDifferences(candidate, program).length > 0)) return candidate;
    }
  }
  throw new Error('Every candidate test Program is already in a Memory.');
}
