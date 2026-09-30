import { describe, expect, it } from 'vitest';
import { runProbe, selectProbes } from '../probe-runner.js';
import { workingRegisterProgram, workingRegisterRequest } from '../testing/frames.js';
import { ScriptedPort, type ScriptStep } from '../testing/scripted-port.js';
import { voicingMasterGainProbe } from './voicing-master-gain.js';

// MIDI channel 1 (00 on the wire). Values in unit byte order: Overdrive 1, Overdrive 2, Master Gain,
// Bass, Midrange, Treble, Presence, Effects Loop, Chorus Depth, Chorus Rate, Voicing.
const REQUEST = workingRegisterRequest(0);
// Master Gain 0, Voicing 1 (Distortion Tube).
const ORIGINAL = [50, 50, 0, 6, 4, 4, 12, 0, 0, 0, 1];
// The probe sets Master Gain to 10 (Display Value 1.0)…
const GAIN_SET = [50, 50, 10, 6, 4, 4, 12, 0, 0, 0, 1];
// …then changes Voicing to 2 (Clean Tube), still sending Master Gain 10.
const VOICING_CHANGED = [50, 50, 10, 6, 4, 4, 12, 0, 0, 0, 2];

/** The probe's traffic, with the unit's reply to the read-back after the Voicing change. */
function script(afterVoicingChange: number[]): ScriptStep[] {
  return [
    { expect: REQUEST, reply: [workingRegisterProgram(0, ORIGINAL)] },
    { expect: workingRegisterProgram(0, GAIN_SET), reply: [] },
    { expect: REQUEST, reply: [workingRegisterProgram(0, GAIN_SET)] },
    { expect: workingRegisterProgram(0, VOICING_CHANGED), reply: [] },
    { expect: REQUEST, reply: [workingRegisterProgram(0, afterVoicingChange)] },
    { expect: workingRegisterProgram(0, ORIGINAL), reply: [] },
    { expect: REQUEST, reply: [workingRegisterProgram(0, ORIGINAL)] },
  ];
}

describe('Voicing → Master Gain probe', () => {
  it('declares that it changes the Working Register, so "all non-destructive" leaves it out', () => {
    expect(voicingMasterGainProbe.kind).toBe('writes-working-register');
    expect(selectProbes([voicingMasterGainProbe], { allNonDestructive: true })).toEqual([]);
  });

  it('confirms the reset when Master Gain reads back as 0 after the Voicing change', async () => {
    const port = new ScriptedPort(script([50, 50, 0, 6, 4, 4, 12, 0, 0, 0, 2]));

    const report = await runProbe(voicingMasterGainProbe, { port, channel: 1, timeoutMs: 10 });

    expect(port.unexpected).toEqual([]);
    expect(port.sent).toHaveLength(7);
    expect(report.verdict).toBe('confirmed');
    expect(report.summary).toMatch(/reset Master Gain to 0/i);
    expect(report.data).toEqual({
      reset: true,
      voicingBefore: 1,
      voicingAfter: 2,
      masterGainBefore: 10,
      masterGainAfter: 0,
    });
    expect(report.findings.join('\n')).toMatch(/Master Gain before the Voicing change: 10; after: 0/);
  });

  it('refutes the reset when Master Gain keeps its value after the Voicing change', async () => {
    const port = new ScriptedPort(script(VOICING_CHANGED));

    const report = await runProbe(voicingMasterGainProbe, { port, channel: 1, timeoutMs: 10 });

    expect(port.unexpected).toEqual([]);
    expect(report.verdict).toBe('refuted');
    expect(report.summary).toMatch(/did not reset Master Gain/i);
    expect(report.data).toEqual({
      reset: false,
      voicingBefore: 1,
      voicingAfter: 2,
      masterGainBefore: 10,
      masterGainAfter: 10,
    });
    expect(report.findings.join('\n')).toMatch(/Master Gain before the Voicing change: 10; after: 10/);
  });

  it('is inconclusive when the Voicing change itself did not take', async () => {
    const port = new ScriptedPort(script(GAIN_SET));

    const report = await runProbe(voicingMasterGainProbe, { port, channel: 1, timeoutMs: 10 });

    expect(port.unexpected).toEqual([]);
    expect(report.verdict).toBe('inconclusive');
    expect(report.summary).toMatch(/Voicing did not change/i);
  });

  it('switches from Clean Tube to Distortion Tube when Clean Tube is already sounding', async () => {
    const clean = [50, 50, 0, 6, 4, 4, 12, 0, 0, 0, 2];
    const cleanGainSet = [50, 50, 10, 6, 4, 4, 12, 0, 0, 0, 2];
    const distortion = [50, 50, 10, 6, 4, 4, 12, 0, 0, 0, 1];
    const port = new ScriptedPort([
      { expect: REQUEST, reply: [workingRegisterProgram(0, clean)] },
      { expect: workingRegisterProgram(0, cleanGainSet), reply: [] },
      { expect: REQUEST, reply: [workingRegisterProgram(0, cleanGainSet)] },
      { expect: workingRegisterProgram(0, distortion), reply: [] },
      { expect: REQUEST, reply: [workingRegisterProgram(0, distortion)] },
      { expect: workingRegisterProgram(0, clean), reply: [] },
      { expect: REQUEST, reply: [workingRegisterProgram(0, clean)] },
    ]);

    const report = await runProbe(voicingMasterGainProbe, { port, channel: 1, timeoutMs: 10 });

    expect(port.unexpected).toEqual([]);
    expect(report.data).toMatchObject({ voicingBefore: 2, voicingAfter: 1, reset: false });
  });
});
