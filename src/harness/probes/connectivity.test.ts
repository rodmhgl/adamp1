import { describe, expect, it } from 'vitest';
import { runProbe } from '../probe-runner.js';
import { ScriptedPort } from '../testing/scripted-port.js';
import { connectivityProbe } from './connectivity.js';

// MIDI channel 3 is 02 on the wire.
// Checksum: 0D + 02 + 08 + 01 = 0x18 (24); 128 - 24 = 104 = 0x68.
const REQUEST_WORKING_REGISTER_CH3 = [0xf0, 0x0d, 0x02, 0x08, 0x01, 0x68, 0xf7];

// Program values: Overdrive 1 10, Overdrive 2 20, Master Gain 16, Bass 3, Midrange 4, Treble 5,
// Presence 6, Effects Loop 1, Chorus Depth 50, Chorus Rate 25, Voicing 2.
// Checksum: 0D + 02 + 09 + 01 + 7F = 152, values sum to 142, total 294.
// 294 mod 128 = 38; 128 - 38 = 90 = 0x5A.
const WORKING_REGISTER_REPLY_CH3 = [
  0xf0, 0x0d, 0x02, 0x09, 0x01, 0x7f, 10, 20, 16, 3, 4, 5, 6, 1, 50, 25, 2, 0x5a, 0xf7,
];

describe('connectivity probe', () => {
  it('requests the Working Register and decodes a valid reply into eleven named raw values', async () => {
    const port = new ScriptedPort([
      { expect: REQUEST_WORKING_REGISTER_CH3, reply: [WORKING_REGISTER_REPLY_CH3] },
    ]);

    const report = await runProbe(connectivityProbe, { port, channel: 3, timeoutMs: 100 });

    expect(port.sent).toEqual([REQUEST_WORKING_REGISTER_CH3]);
    expect(report.verdict).toBe('confirmed');
    expect(report.data).toEqual([
      { name: 'Overdrive 1', raw: 10 },
      { name: 'Overdrive 2', raw: 20 },
      { name: 'Master Gain', raw: 16 },
      { name: 'Bass', raw: 3 },
      { name: 'Midrange', raw: 4 },
      { name: 'Treble', raw: 5 },
      { name: 'Presence', raw: 6 },
      { name: 'Effects Loop', raw: 1 },
      { name: 'Chorus Depth', raw: 50 },
      { name: 'Chorus Rate', raw: 25 },
      { name: 'Voicing', raw: 2 },
    ]);
    expect(report.traffic.map((entry) => [entry.direction, entry.bytes])).toEqual([
      ['sent', REQUEST_WORKING_REGISTER_CH3],
      ['received', WORKING_REGISTER_REPLY_CH3],
    ]);
  });

  it('never confirms a reply whose checksum does not match, and names the mismatch', async () => {
    const corrupted = [...WORKING_REGISTER_REPLY_CH3];
    corrupted[corrupted.length - 2] = 0x5b;
    const port = new ScriptedPort([{ expect: REQUEST_WORKING_REGISTER_CH3, reply: [corrupted] }]);

    const report = await runProbe(connectivityProbe, { port, channel: 3, timeoutMs: 100 });

    expect(report.verdict).toBe('inconclusive');
    expect(report.summary).toMatch(/checksum mismatch/i);
    expect(report.findings.join('\n')).toMatch(/received 5B, computed 5A/);
    expect(report.data).toBeUndefined();
  });

  it('says so when no reply arrives before the timeout, and lists the likely causes', async () => {
    const port = new ScriptedPort([{ expect: REQUEST_WORKING_REGISTER_CH3, reply: [] }]);

    const report = await runProbe(connectivityProbe, { port, channel: 3, timeoutMs: 20 });

    expect(report.verdict).toBe('inconclusive');
    expect(report.summary).toMatch(/no reply .* 20 ms/i);
    const findings = report.findings.join('\n');
    expect(findings).toMatch(/wrong MIDI channel/i);
    expect(findings).toMatch(/ALL or OFF/);
    expect(findings).toMatch(/front-panel edit/i);
    expect(findings).toMatch(/drops SysEx/i);
    expect(findings).toMatch(/firmware .* v1\.x .* no SysEx/i);
    expect(port.sent).toEqual([REQUEST_WORKING_REGISTER_CH3]);
    expect(port.unexpected).toEqual([]);
    expect(report.traffic.map((entry) => entry.direction)).toEqual(['sent']);
  });

  it('refutes, rather than times out, when the unit replies in another format', async () => {
    // The manual's manufacturer ID 00 instead of 0D. Checksum: 00 + 02 + 09 + 01 + 7F = 139,
    // plus values 142 = 281; 281 mod 128 = 25; 128 - 25 = 103 = 0x67.
    const manualStyleReply = [
      0xf0, 0x00, 0x02, 0x09, 0x01, 0x7f, 10, 20, 16, 3, 4, 5, 6, 1, 50, 25, 2, 0x67, 0xf7,
    ];
    const port = new ScriptedPort([{ expect: REQUEST_WORKING_REGISTER_CH3, reply: [manualStyleReply] }]);

    const report = await runProbe(connectivityProbe, { port, channel: 3, timeoutMs: 20 });

    expect(report.verdict).toBe('refuted');
    expect(report.findings.join('\n')).toMatch(/manufacturer ID is 00, not 0D/);
  });

  it('does not confirm a reply that comes back on a different channel', async () => {
    // Same Program on channel 4 (03 on the wire): checksum one lower than the channel 3 reply, 0x59.
    const otherChannelReply = [
      0xf0, 0x0d, 0x03, 0x09, 0x01, 0x7f, 10, 20, 16, 3, 4, 5, 6, 1, 50, 25, 2, 0x59, 0xf7,
    ];
    const port = new ScriptedPort([{ expect: REQUEST_WORKING_REGISTER_CH3, reply: [otherChannelReply] }]);

    const report = await runProbe(connectivityProbe, { port, channel: 3, timeoutMs: 20 });

    expect(report.verdict).toBe('inconclusive');
    expect(report.findings.join('\n')).toMatch(/channel 4.*requested on channel 3/);
  });
});
