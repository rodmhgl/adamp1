import { describe, expect, it } from 'vitest';
import { runProbe, selectProbes } from '../probe-runner.js';
import { doneAfter, ScriptedOperator } from '../testing/scripted-operator.js';
import { ScriptedPort } from '../testing/scripted-port.js';
import { programChangeOutProbe } from './program-change-out.js';

describe('Program Change out probe', () => {
  it('is guided, so "all non-destructive" leaves it out', () => {
    expect(programChangeOutProbe.kind).toBe('guided');
    expect(selectProbes([programChangeOutProbe], { allNonDestructive: true })).toEqual([]);
  });

  it('records the Program Change the unit sends while the maintainer changes program, and its number', async () => {
    const port = new ScriptedPort([]);
    // C0 04: Program Change on channel 1, External Program Number 5.
    const operator = new ScriptedOperator([doneAfter(() => port.emit([0xc0, 0x04])), '5']);

    const report = await runProbe(programChangeOutProbe, { port, operator, channel: 1, timeoutMs: 10 });

    expect(port.sent).toEqual([]);
    expect(operator.events).toEqual([
      { kind: 'instruct', instruction: expect.stringMatching(/select a different Memory on the front panel/i) },
      { kind: 'ask', question: expect.stringMatching(/which Memory/i) },
    ]);
    expect(report.verdict).toBe('confirmed');
    expect(report.data).toEqual({
      memory: 5,
      programChanges: [{ channel: 1, externalProgramNumber: 5, bytes: 'C0 04' }],
    });
    expect(report.findings.join('\n')).toMatch(/External Program Number 5 on channel 1 \(C0 04\): the same as the Memory selected, 5/);
    expect(report.traffic.map(({ direction, bytes }) => [direction, bytes])).toEqual([['received', [0xc0, 0x04]]]);
  });

  it('ignores what the unit sends before the maintainer is asked to change program', async () => {
    const port = new ScriptedPort([]);
    port.emit([0xc0, 0x01]);
    // Active Sensing (FE) is ignored; a Control Change (B0 07 40) is reported as another message.
    const operator = new ScriptedOperator([
      doneAfter(() => {
        port.emit([0xfe]);
        port.emit([0xb0, 0x07, 0x40]);
      }),
      '12',
    ]);

    const report = await runProbe(programChangeOutProbe, { port, operator, channel: 1, timeoutMs: 10 });

    expect(report.verdict).toBe('refuted');
    expect(report.summary).toMatch(/no Program Change/i);
    expect(report.data).toEqual({ memory: 12, programChanges: [] });
    expect(report.findings.join('\n')).toMatch(/1 other message: B0 07 40/);
  });
});
