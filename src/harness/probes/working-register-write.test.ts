import { describe, expect, it } from 'vitest';
import { runProbe, selectProbes } from '../probe-runner.js';
import { workingRegisterProgram, workingRegisterRequest } from '../testing/frames.js';
import { ScriptedPort } from '../testing/scripted-port.js';
import { WRITE_TEST_PROGRAM, workingRegisterWriteProbe } from './working-register-write.js';

// MIDI channel 1 (00 on the wire).
const REQUEST = workingRegisterRequest(0);
// The Program sounding before the probe: Overdrive 1 50, Overdrive 2 50, Master Gain 18, Bass 6,
// Midrange 4, Treble 4, Presence 12, Effects Loop 0, Chorus Depth 0, Chorus Rate 0, Voicing 1.
const ORIGINAL = [50, 50, 18, 6, 4, 4, 12, 0, 0, 0, 1];

// The frame is the same whether the harness writes it or the unit replies with it.
// For the test Program on channel 1: 0D + 00 + 09 + 01 + 7F = 150, values sum to 140, total 290;
// 290 mod 128 = 34; 128 - 34 = 94 = 0x5E.
const WRITE_TEST = [0xf0, 0x0d, 0x00, 0x09, 0x01, 0x7f, 10, 20, 16, 3, 4, 5, 6, 0, 50, 25, 1, 0x5e, 0xf7];

describe('Working Register write and read-back probe', () => {
  it('declares that it changes the Working Register, so "all non-destructive" leaves it out', () => {
    expect(workingRegisterWriteProbe.kind).toBe('writes-working-register');
    expect(selectProbes([workingRegisterWriteProbe], { allNonDestructive: true })).toEqual([]);
  });

  it('confirms when the Program read back matches the one written, then restores the original', async () => {
    expect(workingRegisterProgram(0, WRITE_TEST_PROGRAM)).toEqual(WRITE_TEST);
    const port = new ScriptedPort([
      { expect: REQUEST, reply: [workingRegisterProgram(0, ORIGINAL)] },
      { expect: WRITE_TEST, reply: [] },
      { expect: REQUEST, reply: [WRITE_TEST] },
      { expect: workingRegisterProgram(0, ORIGINAL), reply: [] },
      { expect: REQUEST, reply: [workingRegisterProgram(0, ORIGINAL)] },
    ]);

    const report = await runProbe(workingRegisterWriteProbe, { port, channel: 1, timeoutMs: 10 });

    expect(port.unexpected).toEqual([]);
    expect(port.sent).toHaveLength(5);
    expect(report.verdict).toBe('confirmed');
    expect(report.data).toEqual({ wrote: WRITE_TEST_PROGRAM, readBack: WRITE_TEST_PROGRAM, differences: [] });
    expect(report.findings.join('\n')).toMatch(/restored/i);
  });

  it('refutes with a per-parameter diff when the Program read back differs', async () => {
    const readBack = [...WRITE_TEST_PROGRAM];
    readBack[3] = 9; // Bass
    readBack[10] = 2; // Voicing
    const port = new ScriptedPort([
      { expect: REQUEST, reply: [workingRegisterProgram(0, ORIGINAL)] },
      { expect: WRITE_TEST, reply: [] },
      { expect: REQUEST, reply: [workingRegisterProgram(0, readBack)] },
      { expect: workingRegisterProgram(0, ORIGINAL), reply: [] },
      { expect: REQUEST, reply: [workingRegisterProgram(0, ORIGINAL)] },
    ]);

    const report = await runProbe(workingRegisterWriteProbe, { port, channel: 1, timeoutMs: 10 });

    expect(port.unexpected).toEqual([]);
    expect(report.verdict).toBe('refuted');
    expect(report.data?.differences).toEqual([
      { name: 'Bass', wrote: 3, readBack: 9 },
      { name: 'Voicing', wrote: 1, readBack: 2 },
    ]);
    const findings = report.findings.join('\n');
    expect(findings).toMatch(/Bass: wrote 3, read back 9/);
    expect(findings).toMatch(/Voicing: wrote 1, read back 2/);
  });

  it('writes nothing when the Working Register cannot be read first, since it could not be restored', async () => {
    const port = new ScriptedPort([{ expect: REQUEST, reply: [] }]);

    const report = await runProbe(workingRegisterWriteProbe, { port, channel: 1, timeoutMs: 10 });

    expect(port.sent).toEqual([REQUEST]);
    expect(report.verdict).toBe('inconclusive');
    expect(report.summary).toMatch(/nothing was written/i);
    expect(report.findings.join('\n')).toMatch(/no reply .* 10 ms/i);
  });

  it('warns in the findings when the restore does not read back as the original', async () => {
    const port = new ScriptedPort([
      { expect: REQUEST, reply: [workingRegisterProgram(0, ORIGINAL)] },
      { expect: WRITE_TEST, reply: [] },
      { expect: REQUEST, reply: [WRITE_TEST] },
      { expect: workingRegisterProgram(0, ORIGINAL), reply: [] },
      { expect: REQUEST, reply: [WRITE_TEST] },
    ]);

    const report = await runProbe(workingRegisterWriteProbe, { port, channel: 1, timeoutMs: 10 });

    expect(report.verdict).toBe('confirmed');
    expect(report.findings.join('\n')).toMatch(/restore .* did not read back .*recall the program/i);
  });
});
