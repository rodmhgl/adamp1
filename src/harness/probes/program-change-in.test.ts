import { describe, expect, it } from 'vitest';
import { MEMORY_COUNT } from '../../core/memory-image.js';
import { runProbe, selectProbes, type VerifiedBackup } from '../probe-runner.js';
import { memoryImage, memoryImageRequest, workingRegisterProgram, workingRegisterRequest } from '../testing/frames.js';
import { DONE, ScriptedOperator, type OperatorAnswer } from '../testing/scripted-operator.js';
import { ScriptedPort, type ScriptStep } from '../testing/scripted-port.js';
import { programChangeInProbe } from './program-change-in.js';

// MIDI channel 1 (00 on the wire). Every Memory holds a different Program: Memory m has Overdrive 1 at m - 1.
const PROGRAMS = Array.from({ length: MEMORY_COUNT }, (_, i) => [i, 20, 16, 3, 4, 5, 6, 0, 50, 25, 1]);
const memoryProgram = (memory: number) => PROGRAMS[memory - 1]!;
const BACKUP: VerifiedBackup = {
  syxFile: 'memory-image-1.syx',
  decodedFile: 'memory-image-1.json',
  image: { programs: PROGRAMS.map((raw) => ({ raw })) },
};

// C0 09: Program Change on channel 1 for External Program Number 10.
const PROGRAM_CHANGE_10 = [0xc0, 0x09];
const REQUEST = workingRegisterRequest(0);

async function run(script: ScriptStep[], answers: OperatorAnswer[], backup: VerifiedBackup | undefined = BACKUP) {
  const port = new ScriptedPort(script);
  const operator = new ScriptedOperator(answers);
  const report = await runProbe(programChangeInProbe, {
    port,
    operator,
    channel: 1,
    timeoutMs: 10,
    dumpTimeoutMs: 10,
    backup: () => backup,
  });
  return { port, operator, report };
}

describe('Program Change in probe', () => {
  it('is guided, so "all non-destructive" leaves it out', () => {
    expect(programChangeInProbe.kind).toBe('guided');
    expect(selectProbes([programChangeInProbe], { allNonDestructive: true })).toEqual([]);
  });

  it('confirms that External Program Number 10 loads Memory 10, from the display and the Working Register', async () => {
    const { port, operator, report } = await run(
      [
        { expect: PROGRAM_CHANGE_10, reply: [] },
        { expect: REQUEST, reply: [workingRegisterProgram(0, memoryProgram(10))] },
      ],
      ['3', true, '10', DONE],
    );

    expect(port.unexpected).toEqual([]);
    expect(port.sent).toEqual([PROGRAM_CHANGE_10, REQUEST]);
    expect(operator.events).toEqual([
      { kind: 'ask', question: expect.stringMatching(/which Memory/i) },
      { kind: 'confirm', question: expect.stringMatching(/Program Change[\s\S]*External Program Number 10[\s\S]*unstored/i) },
      { kind: 'ask', question: expect.stringMatching(/which Memory/i) },
      { kind: 'instruct', instruction: expect.stringMatching(/select Memory 3/i) },
    ]);
    expect(report.verdict).toBe('confirmed');
    expect(report.data).toEqual({ externalProgramNumber: 10, memoryBefore: 3, displayedMemory: 10, matchingMemories: [10] });
    expect(report.findings.join('\n')).toMatch(/Working Register matches Memory 10/);
  });

  it('sends nothing when the maintainer declines', async () => {
    const { port, report } = await run([], ['3', false]);

    expect(port.sent).toEqual([]);
    expect(report.verdict).toBe('inconclusive');
    expect(report.summary).toMatch(/declined/);
  });

  it('refutes one-to-one when the Program Change loads another Memory, and reports which', async () => {
    const { report } = await run(
      [
        { expect: PROGRAM_CHANGE_10, reply: [] },
        { expect: REQUEST, reply: [workingRegisterProgram(0, memoryProgram(9))] },
      ],
      ['3', true, '9', DONE],
    );

    expect(report.verdict).toBe('refuted');
    expect(report.summary).toMatch(/External Program Number 10 loaded Memory 9/);
    expect(report.data).toMatchObject({ displayedMemory: 9, matchingMemories: [9] });
  });

  it('relies on the display when the Working Register cannot be read, as on a Level 1 unit', async () => {
    const { report } = await run(
      [
        { expect: PROGRAM_CHANGE_10, reply: [] },
        { expect: REQUEST, reply: [] },
      ],
      ['3', true, '10', DONE],
    );

    expect(report.verdict).toBe('confirmed');
    expect(report.data).toEqual({ externalProgramNumber: 10, memoryBefore: 3, displayedMemory: 10 });
    expect(report.findings.join('\n')).toMatch(/No reply to the Working Register request/);
  });

  it('dumps the Memory Image to match the Working Register against when the session has no backup', async () => {
    const { port, report } = await run(
      [
        { expect: PROGRAM_CHANGE_10, reply: [] },
        { expect: REQUEST, reply: [workingRegisterProgram(0, memoryProgram(10))] },
        { expect: memoryImageRequest(0), reply: [memoryImage(0, PROGRAMS)] },
      ],
      ['3', true, '10', DONE],
      undefined,
    );

    expect(port.unexpected).toEqual([]);
    expect(report.data).toMatchObject({ matchingMemories: [10] });
  });

  it('is inconclusive when the display and the Working Register disagree', async () => {
    const { report } = await run(
      [
        { expect: PROGRAM_CHANGE_10, reply: [] },
        { expect: REQUEST, reply: [workingRegisterProgram(0, memoryProgram(9))] },
      ],
      ['3', true, '10', DONE],
    );

    expect(report.verdict).toBe('inconclusive');
    expect(report.summary).toMatch(/display .* Working Register disagree/i);
  });

  it('is inconclusive when the display still shows the Memory from before', async () => {
    const { report } = await run(
      [
        { expect: PROGRAM_CHANGE_10, reply: [] },
        { expect: REQUEST, reply: [] },
      ],
      ['3', true, '3', DONE],
    );

    expect(report.verdict).toBe('inconclusive');
    expect(report.summary).toMatch(/still shows Memory 3/);
  });

  it('sends External Program Number 20 instead when Memory 10 is already selected', async () => {
    // C0 13: External Program Number 20.
    const { port, report } = await run(
      [
        { expect: [0xc0, 0x13], reply: [] },
        { expect: REQUEST, reply: [workingRegisterProgram(0, memoryProgram(20))] },
      ],
      ['10', true, '20', DONE],
    );

    expect(port.unexpected).toEqual([]);
    expect(report.verdict).toBe('confirmed');
  });
});
