import { describe, expect, it } from 'vitest';
import { runProbe, selectProbes } from '../probe-runner.js';
import { workingRegisterProgram, workingRegisterRequest } from '../testing/frames.js';
import { doneAfter, ScriptedOperator } from '../testing/scripted-operator.js';
import { ScriptedPort } from '../testing/scripted-port.js';
import { frontPanelLockoutProbe } from './front-panel-lockout.js';

// MIDI channel 1 (00 on the wire).
const REQUEST = workingRegisterRequest(0);
const REPLY = workingRegisterProgram(0, [50, 50, 16, 6, 4, 4, 12, 0, 0, 0, 1]);

async function run(duringEdit: number[][], afterEdit: number[][]) {
  const port = new ScriptedPort([
    { expect: REQUEST, reply: duringEdit },
    { expect: REQUEST, reply: afterEdit },
  ]);
  /** How many messages had been sent when the maintainer confirmed each instruction. */
  const sentAtConfirmation: number[] = [];
  const confirm = doneAfter(() => sentAtConfirmation.push(port.sent.length));
  const operator = new ScriptedOperator([confirm, confirm]);
  const report = await runProbe(frontPanelLockoutProbe, { port, operator, channel: 1, timeoutMs: 10 });
  return { port, operator, report, sentAtConfirmation };
}

describe('front-panel lockout probe', () => {
  it('is guided, so "all non-destructive" leaves it out', () => {
    expect(frontPanelLockoutProbe.kind).toBe('guided');
    expect(selectProbes([frontPanelLockoutProbe], { allNonDestructive: true })).toEqual([]);
  });

  it('asks for an edit, probes once it has started, then asks for it to be abandoned and probes again', async () => {
    const { port, operator, report, sentAtConfirmation } = await run([], [REPLY]);

    expect(port.unexpected).toEqual([]);
    expect(operator.events).toEqual([
      { kind: 'instruct', instruction: expect.stringMatching(/start a front-panel edit[\s\S]*EDIT[\s\S]*change nothing/i) },
      { kind: 'instruct', instruction: expect.stringMatching(/abandon the edit[\s\S]*EDIT/i) },
    ]);
    expect(sentAtConfirmation).toEqual([0, 1]);
    expect(report.verdict).toBe('confirmed');
    expect(report.summary).toMatch(/did not reply during the front-panel edit/i);
    expect(report.data).toEqual({ repliedDuringEdit: false, repliedAfterEdit: true });
  });

  it('refutes the lockout when the unit replies during the edit', async () => {
    const { report } = await run([REPLY], [REPLY]);

    expect(report.verdict).toBe('refuted');
    expect(report.summary).toMatch(/replied during the front-panel edit/i);
    expect(report.data).toEqual({ repliedDuringEdit: true, repliedAfterEdit: true });
    expect(report.findings.join('\n')).toMatch(/During the edit: reply F0 0D 00 09/);
  });

  it('is inconclusive when the unit does not reply after the edit either', async () => {
    const { report } = await run([], []);

    expect(report.verdict).toBe('inconclusive');
    expect(report.data).toEqual({ repliedDuringEdit: false, repliedAfterEdit: false });
  });
});
