import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selectProbes } from '../probe-runner.js';
import { runSession, type SessionOptions } from '../session.js';
import { addressedProgram, memoryImage, memoryImageRequest, workingRegisterProgram, workingRegisterRequest } from '../testing/frames.js';
import { DONE, ScriptedOperator, type OperatorAnswer } from '../testing/scripted-operator.js';
import { ScriptedPort, type ScriptStep } from '../testing/scripted-port.js';
import { directMemoryWriteProbe, type DirectMemoryWriteResult } from './direct-memory-write.js';
import { memoryImageDumpProbe } from './memory-image-dump.js';

// MIDI channel 1 (00 on the wire).
const DUMP_REQUEST = memoryImageRequest(0);

/** Memory n holds Overdrive 1 n - 1, so every Memory differs and the order shows. */
const BACKUP = Array.from({ length: 128 }, (_, i) => [i, 20, 16, 3, 4, 5, 6, 0, 50, 25, 1]);
/** The first Program the probe sends: the test Program with Overdrive 1 and 2 at 0, which no Memory holds. */
const FIRST_PROGRAM = [0, 0, 16, 3, 4, 5, 6, 0, 50, 25, 1];
/** The second Program, once the first is in a Memory: Overdrive 2 moves on to 1. */
const NEXT_PROGRAM = [0, 1, 16, 3, 4, 5, 6, 0, 50, 25, 1];

/** `image` with Memory `memory` (1–128) holding `program`. */
function withMemory(image: readonly number[][], memory: number, program: number[]): number[][] {
  return image.map((values, i) => (i === memory - 1 ? program : values));
}

/** The Program sounding when the probe starts, which no test Program may match. */
const SOUNDING = [60, 60, 16, 3, 4, 5, 6, 0, 50, 25, 1];

const BACKUP_DUMP: ScriptStep = { expect: DUMP_REQUEST, reply: [memoryImage(0, BACKUP)] };
/** The 0-based attempt addresses Memory 2 as 01; the 1-based attempt as 02. */
const zeroBased = (program: number[]): ScriptStep => ({ expect: addressedProgram(0, 0x01, program), reply: [] });
const oneBased = (program: number[]): ScriptStep => ({ expect: addressedProgram(0, 0x02, program), reply: [] });
const dump = (image: number[][]): ScriptStep => ({ expect: DUMP_REQUEST, reply: [memoryImage(0, image)] });
/** Reads the Working Register, which holds `program`: first at the start, then after each attempt's dump. */
const readWorkingRegister = (program = SOUNDING): ScriptStep => ({
  expect: workingRegisterRequest(0),
  reply: [workingRegisterProgram(0, program)],
});
/** What the probe sends at its end to put the sounding Program back, and the read that checks it. */
const RESTORE_SOUNDING: ScriptStep[] = [{ expect: workingRegisterProgram(0, SOUNDING), reply: [] }, readWorkingRegister()];
const RESTORE_BACKUP: ScriptStep[] = [
  { expect: memoryImage(0, BACKUP), reply: [] },
  { expect: DUMP_REQUEST, reply: [memoryImage(0, BACKUP)] },
];

const CONNECTION = { input: 'UM-ONE In', output: 'UM-ONE Out', channel: 1 };

describe('direct Memory write probe', () => {
  let sessionDir: string;
  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), 'adamp1-direct-'));
  });
  afterEach(() => rm(sessionDir, { recursive: true, force: true }));

  async function runDirectWrite(script: ScriptStep[], answers: OperatorAnswer[], options: Partial<SessionOptions> = {}) {
    const port = new ScriptedPort(script);
    const operator = new ScriptedOperator(['2.01', ...answers]);
    const report = await runSession({
      port,
      operator,
      connection: CONNECTION,
      timeoutMs: 10,
      dumpTimeoutMs: 50,
      probes: [memoryImageDumpProbe, directMemoryWriteProbe],
      sessionDir,
      ...options,
    });
    const write = report.probes.find(({ probe }) => probe === 'direct-memory-write');
    return { port, operator, write, data: write?.data as DirectMemoryWriteResult | undefined };
  }

  it('declares that it writes Memories, so "all non-destructive" leaves it out', () => {
    expect(directMemoryWriteProbe.kind).toBe('writes-memories');
    expect(selectProbes([directMemoryWriteProbe], { allNonDestructive: true })).toEqual([]);
  });

  it('is refused when the session has no verified backup, and sends nothing', async () => {
    const { port, write } = await runDirectWrite([], [], { probes: [directMemoryWriteProbe] });

    expect(port.sent).toEqual([]);
    expect(write?.summary).toMatch(/refused.*no verified backup/i);
  });

  /** The dump probe's backup, the probe's start, and each attempt's write, dump and Working Register read. */
  function attempts(...steps: [write: ScriptStep, image: number[][], workingRegister?: number[]][]): ScriptStep[] {
    return [
      BACKUP_DUMP,
      readWorkingRegister(),
      ...steps.flatMap(([write, image, workingRegister]) => [write, dump(image), readWorkingRegister(workingRegister)]),
    ];
  }

  it('asks to confirm each write, naming the address and the backup, then for Protect OFF', async () => {
    const { operator } = await runDirectWrite(
      [...attempts([zeroBased(FIRST_PROGRAM), BACKUP], [oneBased(FIRST_PROGRAM), BACKUP]), ...RESTORE_SOUNDING],
      [true, DONE, true, DONE],
    );

    expect(operator.events.slice(1)).toEqual([
      { kind: 'confirm', question: expect.stringMatching(/address 01.*one Memory.*memory-image-1\.syx/) },
      { kind: 'instruct', instruction: expect.stringMatching(/Protect OFF/) },
      { kind: 'confirm', question: expect.stringMatching(/address 02/) },
      { kind: 'instruct', instruction: expect.stringMatching(/Protect OFF/) },
    ]);
  });

  it('confirms a direct write that works with 1-based numbering, reports each attempt, and restores both', async () => {
    const written = withMemory(BACKUP, 2, FIRST_PROGRAM);
    const { port, write, data } = await runDirectWrite(
      [...attempts([zeroBased(FIRST_PROGRAM), BACKUP], [oneBased(FIRST_PROGRAM), written]), ...RESTORE_SOUNDING, ...RESTORE_BACKUP],
      [true, DONE, true, DONE],
    );

    expect(port.unexpected).toEqual([]);
    expect(write?.verdict).toBe('confirmed');
    expect(write?.summary).toMatch(/1-based.*address 02 wrote Memory 2/);
    expect(data).toEqual({
      targetMemory: 2,
      attempts: [
        { numbering: '0-based', address: 0x01, program: FIRST_PROGRAM, changedMemories: [], wroteTarget: false, landedInWorkingRegister: false },
        { numbering: '1-based', address: 0x02, program: FIRST_PROGRAM, changedMemories: [2], wroteTarget: true, landedInWorkingRegister: false },
      ],
      numberingsThatWroteTarget: ['1-based'],
    });
    const findings = write?.findings.join('\n');
    expect(findings).toMatch(/0-based: .*address 01.*no Memory changed/);
    expect(findings).toMatch(/1-based: .*address 02.*Memory 2 now holds the Program sent/);
    expect(findings).toMatch(/Restored the Working Register/);
    expect(findings).toMatch(/Restored the backup .*matches/);
  });

  it('compares each attempt with the dump before it, and names a Memory the wrong numbering wrote', async () => {
    // A 0-based unit: address 01 writes Memory 2, then address 02 writes Memory 3.
    const afterFirst = withMemory(BACKUP, 2, FIRST_PROGRAM);
    const afterSecond = withMemory(afterFirst, 3, NEXT_PROGRAM);
    const { port, write, data } = await runDirectWrite(
      [...attempts([zeroBased(FIRST_PROGRAM), afterFirst], [oneBased(NEXT_PROGRAM), afterSecond]), ...RESTORE_SOUNDING, ...RESTORE_BACKUP],
      [true, DONE, true, DONE],
    );

    expect(port.unexpected).toEqual([]);
    expect(write?.verdict).toBe('confirmed');
    expect(data?.numberingsThatWroteTarget).toEqual(['0-based']);
    expect(data?.attempts.map(({ changedMemories }) => changedMemories)).toEqual([[2], [3]]);
    expect(write?.findings.join('\n')).toMatch(/1-based: .*address 02.*Memory 3 now holds the Program sent/);
  });

  it('refutes a direct write when no attempt changes any Memory, and leaves the Memories alone', async () => {
    const { port, write, data } = await runDirectWrite(
      [...attempts([zeroBased(FIRST_PROGRAM), BACKUP], [oneBased(FIRST_PROGRAM), BACKUP]), ...RESTORE_SOUNDING],
      [true, DONE, true, DONE],
    );

    expect(port.unexpected).toEqual([]);
    expect(port.sent.at(-2)).toEqual(workingRegisterProgram(0, SOUNDING));
    expect(write?.verdict).toBe('refuted');
    expect(write?.summary).toMatch(/no Memory changed/i);
    expect(write?.summary).not.toMatch(/Working Register/);
    expect(data?.numberingsThatWroteTarget).toEqual([]);
    expect(data?.attempts.map(({ changedMemories }) => changedMemories)).toEqual([[], []]);
    expect(write?.findings.join('\n')).not.toMatch(/Restored the backup/);
  });

  it('says so when the Program went to the Working Register instead, and puts the sounding Program back', async () => {
    const { port, write, data } = await runDirectWrite(
      [...attempts([zeroBased(FIRST_PROGRAM), BACKUP, FIRST_PROGRAM], [oneBased(FIRST_PROGRAM), BACKUP, FIRST_PROGRAM]), ...RESTORE_SOUNDING],
      [true, DONE, true, DONE],
    );

    expect(port.unexpected).toEqual([]);
    expect(write?.verdict).toBe('refuted');
    expect(write?.summary).toMatch(/went to the Working Register instead/);
    expect(data?.attempts.map(({ landedInWorkingRegister }) => landedInWorkingRegister)).toEqual([true, true]);
    const findings = write?.findings.join('\n');
    expect(findings).toMatch(/Working Register now holds the Program sent/);
    expect(findings).toMatch(/Restored the Working Register/);
  });

  it('is inconclusive when a write changes a Memory to something other than the Program sent', async () => {
    const garbled = withMemory(BACKUP, 2, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const { write, data } = await runDirectWrite(
      [...attempts([zeroBased(FIRST_PROGRAM), garbled], [oneBased(FIRST_PROGRAM), garbled]), ...RESTORE_SOUNDING, ...RESTORE_BACKUP],
      [true, DONE, true, DONE],
    );

    expect(write?.verdict).toBe('inconclusive');
    expect(data?.attempts[0]).toMatchObject({ changedMemories: [2], wroteTarget: false });
    expect(write?.findings.join('\n')).toMatch(/Memory 2: Master Gain was 16, read back 0/);
  });

  it('restores the backup when the dump after a write fails part-way', async () => {
    const { port, write } = await runDirectWrite(
      [
        BACKUP_DUMP,
        readWorkingRegister(),
        zeroBased(FIRST_PROGRAM),
        { expect: DUMP_REQUEST, reply: [] },
        ...RESTORE_SOUNDING,
        ...RESTORE_BACKUP,
      ],
      [true, DONE],
    );

    expect(port.unexpected).toEqual([]);
    expect(port.sent.slice(-2)).toEqual([memoryImage(0, BACKUP), DUMP_REQUEST]);
    expect(write?.verdict).toBe('inconclusive');
    const findings = write?.findings.join('\n');
    expect(findings).toMatch(/No reply to the Memory Image request/);
    expect(findings).toMatch(/Restored the backup .*matches/);
  });

  it('restores the backup when the maintainer declines the second write, keeping the first attempt', async () => {
    const written = withMemory(BACKUP, 2, FIRST_PROGRAM);
    const { port, write } = await runDirectWrite(
      [...attempts([zeroBased(FIRST_PROGRAM), written]), ...RESTORE_SOUNDING, ...RESTORE_BACKUP],
      [true, DONE, false],
    );

    expect(port.unexpected).toEqual([]);
    expect(write?.verdict).toBe('inconclusive');
    expect(write?.summary).toMatch(/declined the write to address 02/);
    const findings = write?.findings.join('\n');
    expect(findings).toMatch(/0-based: .*Memory 2 now holds the Program sent/);
    expect(findings).toMatch(/Restored the backup/);
  });

  it('restores the backup when stopped while the dump after a write is under way', async () => {
    const stop = new AbortController();
    const { port, write } = await runDirectWrite(
      [
        BACKUP_DUMP,
        readWorkingRegister(),
        zeroBased(FIRST_PROGRAM),
        { expect: DUMP_REQUEST, reply: [], afterSend: () => stop.abort() },
        ...RESTORE_BACKUP,
      ],
      [true, DONE],
      { signal: stop.signal },
    );

    expect(port.unexpected).toEqual([]);
    expect(write?.summary).toMatch(/stopped/i);
    expect(write?.findings.join('\n')).toMatch(/Restored the backup .*matches/);
  });
});
