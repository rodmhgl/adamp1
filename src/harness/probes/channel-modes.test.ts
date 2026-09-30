import { describe, expect, it } from 'vitest';
import { runProbe, selectProbes } from '../probe-runner.js';
import { workingRegisterProgram, workingRegisterRequest } from '../testing/frames.js';
import { doneAfter, ScriptedOperator } from '../testing/scripted-operator.js';
import { ScriptedPort, type ScriptStep } from '../testing/scripted-port.js';
import { channelModesProbe } from './channel-modes.js';

// The session is on MIDI channel 1 (00 on the wire); channel 2 (01) is the one the unit should ignore.
const ON_CHANNEL_1 = workingRegisterRequest(0);
const ON_CHANNEL_2 = workingRegisterRequest(1);
// The Working Register request with the channel byte left out: F0 0D 08 01 <checksum> F7.
// Checksum: 0D + 08 + 01 = 22; 128 - 22 = 106 = 0x6A.
const NO_CHANNEL_BYTE = [0xf0, 0x0d, 0x08, 0x01, 0x6a, 0xf7];

const PROGRAM = [50, 50, 16, 6, 4, 4, 12, 0, 0, 0, 1];
const REPLY_ON_1 = workingRegisterProgram(0, PROGRAM);
const REPLY_ON_2 = workingRegisterProgram(1, PROGRAM);

interface Replies {
  all: [number[][], number[][]];
  off: [number[][], number[][]];
  channel: [number[][], number[][]];
}

/** The probe's traffic: two requests per channel mode, answered as given. */
function script({ all, off, channel }: Replies): ScriptStep[] {
  return [
    { expect: ON_CHANNEL_1, reply: all[0] },
    { expect: ON_CHANNEL_2, reply: all[1] },
    { expect: ON_CHANNEL_1, reply: off[0] },
    { expect: NO_CHANNEL_BYTE, reply: off[1] },
    { expect: ON_CHANNEL_1, reply: channel[0] },
    { expect: ON_CHANNEL_2, reply: channel[1] },
  ];
}

async function run(replies: Replies) {
  const port = new ScriptedPort(script(replies));
  /** How many messages had been sent when the maintainer confirmed each instruction. */
  const sentAtConfirmation: number[] = [];
  const confirm = doneAfter(() => sentAtConfirmation.push(port.sent.length));
  const operator = new ScriptedOperator([confirm, confirm, confirm]);
  const report = await runProbe(channelModesProbe, { port, operator, channel: 1, timeoutMs: 10 });
  return { port, operator, report, sentAtConfirmation };
}

describe('MIDI channel modes probe', () => {
  it('is guided, so "all non-destructive" leaves it out', () => {
    expect(channelModesProbe.kind).toBe('guided');
    expect(selectProbes([channelModesProbe], { allNonDestructive: true })).toEqual([]);
  });

  it('has the maintainer set ALL, OFF and then the session channel, probing only after each is confirmed', async () => {
    const { port, operator, report, sentAtConfirmation } = await run({
      all: [[REPLY_ON_1], [REPLY_ON_2]],
      off: [[], []],
      channel: [[REPLY_ON_1], []],
    });

    expect(port.unexpected).toEqual([]);
    expect(operator.events.map((event) => event.kind === 'instruct' && event.instruction)).toEqual([
      expect.stringMatching(/to ALL:[\s\S]*MIDI CHNL/),
      expect.stringMatching(/to OFF:[\s\S]*MIDI CHNL/),
      expect.stringMatching(/channel 1:[\s\S]*MIDI CHNL/),
    ]);
    expect(sentAtConfirmation).toEqual([0, 2, 4]);
    expect(report.verdict).toBe('confirmed');
    expect(report.data).toEqual([
      { setting: 'ALL', addressed: 'on channel 1', sent: 'F0 0D 00 08 01 6A F7', reply: expect.any(String), replyChannel: 1 },
      { setting: 'ALL', addressed: 'on channel 2', sent: 'F0 0D 01 08 01 69 F7', reply: expect.any(String), replyChannel: 2 },
      { setting: 'OFF', addressed: 'on channel 1', sent: 'F0 0D 00 08 01 6A F7' },
      { setting: 'OFF', addressed: 'with no channel byte', sent: 'F0 0D 08 01 6A F7' },
      { setting: 'channel 1', addressed: 'on channel 1', sent: 'F0 0D 00 08 01 6A F7', reply: expect.any(String), replyChannel: 1 },
      { setting: 'channel 1', addressed: 'on channel 2', sent: 'F0 0D 01 08 01 69 F7' },
    ]);
  });

  it('reports OFF with and without the channel byte separately, and refutes when OFF still answers', async () => {
    const { report } = await run({
      all: [[REPLY_ON_1], [REPLY_ON_2]],
      off: [[], [REPLY_ON_1]],
      channel: [[REPLY_ON_1], []],
    });

    // A reply to the message with no channel byte is recorded, but is not part of the hypothesis.
    expect(report.verdict).toBe('confirmed');
    const findings = report.findings.join('\n');
    expect(findings).toMatch(/OFF, on channel 1: no reply/);
    expect(findings).toMatch(/OFF, with no channel byte: reply F0 0D 00 09/);

    const offAnswers = await run({
      all: [[REPLY_ON_1], [REPLY_ON_2]],
      off: [[REPLY_ON_1], []],
      channel: [[REPLY_ON_1], []],
    });
    expect(offAnswers.report.verdict).toBe('refuted');
    expect(offAnswers.report.findings.join('\n')).toMatch(/OFF: answered on channel 1/);
  });

  it('refutes when the unit set to one channel answers on another', async () => {
    const { report } = await run({
      all: [[REPLY_ON_1], [REPLY_ON_2]],
      off: [[], []],
      channel: [[REPLY_ON_1], [REPLY_ON_2]],
    });

    expect(report.verdict).toBe('refuted');
    expect(report.findings.join('\n')).toMatch(/channel 1: answered on channel 2/);
  });

  it('is inconclusive when the unit never answers on its own channel, as a Level 1 unit would', async () => {
    const { report } = await run({ all: [[], []], off: [[], []], channel: [[], []] });

    expect(report.verdict).toBe('inconclusive');
    expect(report.summary).toMatch(/never answered .* its own channel/i);
  });
});
