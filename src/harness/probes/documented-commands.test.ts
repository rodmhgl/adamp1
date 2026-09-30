import { describe, expect, it } from 'vitest';
import { runProbe, selectProbes } from '../probe-runner.js';
import { ScriptedPort } from '../testing/scripted-port.js';
import { documentedCommandsProbe } from './documented-commands.js';

// The manual's layout: F0 <ID> <channel> <device> <command> … <checksum> F7, on MIDI channel 1 (00).
// Checksums are the 7-bit two's complement of the sum of the bytes between F0 and the checksum.

// Get Parameters: 07 7F (Working Register) 0B (eleven parameters) 00 (from parameter 00).
// ID 0D, device 00: 0D + 07 + 7F + 0B = 158; 158 mod 128 = 30; 128 - 30 = 98 = 0x62.
const GET_0D_DEVICE_00 = [0xf0, 0x0d, 0x00, 0x00, 0x07, 0x7f, 0x0b, 0x00, 0x62, 0xf7];
const GET_0D_DEVICE_01 = [0xf0, 0x0d, 0x00, 0x01, 0x07, 0x7f, 0x0b, 0x00, 0x61, 0xf7]; // 159 → 97
const GET_00_DEVICE_00 = [0xf0, 0x00, 0x00, 0x00, 0x07, 0x7f, 0x0b, 0x00, 0x6f, 0xf7]; // 145 → 111
const GET_00_DEVICE_01 = [0xf0, 0x00, 0x00, 0x01, 0x07, 0x7f, 0x0b, 0x00, 0x6e, 0xf7]; // 146 → 110

// Set Parameters: 06 7F (Working Register) 01 (one parameter) 02 (Master Gain) 00 (value 0).
// ID 0D, device 00: 0D + 06 + 7F + 01 + 02 = 149; 149 mod 128 = 21; 128 - 21 = 107 = 0x6B.
const SET_0D_DEVICE_00 = [0xf0, 0x0d, 0x00, 0x00, 0x06, 0x7f, 0x01, 0x02, 0x00, 0x6b, 0xf7];
const SET_0D_DEVICE_01 = [0xf0, 0x0d, 0x00, 0x01, 0x06, 0x7f, 0x01, 0x02, 0x00, 0x6a, 0xf7]; // 150 → 106
const SET_00_DEVICE_00 = [0xf0, 0x00, 0x00, 0x00, 0x06, 0x7f, 0x01, 0x02, 0x00, 0x78, 0xf7]; // 136 → 120
const SET_00_DEVICE_01 = [0xf0, 0x00, 0x00, 0x01, 0x06, 0x7f, 0x01, 0x02, 0x00, 0x77, 0xf7]; // 137 → 119

const ALL_VARIANTS = [
  GET_0D_DEVICE_00,
  GET_0D_DEVICE_01,
  GET_00_DEVICE_00,
  GET_00_DEVICE_01,
  SET_0D_DEVICE_00,
  SET_0D_DEVICE_01,
  SET_00_DEVICE_00,
  SET_00_DEVICE_01,
];

describe("probe of the manual's documented commands", () => {
  it('declares that it changes the Working Register, so "all non-destructive" leaves it out', () => {
    expect(documentedCommandsProbe.kind).toBe('writes-working-register');
    expect(selectProbes([documentedCommandsProbe], { allNonDestructive: true })).toEqual([]);
  });

  it('sends every variant to the Working Register and reports a silent unit as inconclusive', async () => {
    const port = new ScriptedPort(ALL_VARIANTS.map((expect) => ({ expect, reply: [] })));

    const report = await runProbe(documentedCommandsProbe, { port, channel: 1, timeoutMs: 10 });

    expect(port.sent).toEqual(ALL_VARIANTS);
    expect(port.unexpected).toEqual([]);
    expect(report.verdict).toBe('inconclusive');
    expect(report.summary).toMatch(/no reply .* 10 ms/i);
    expect(report.data?.every((variant) => variant.reply === undefined)).toBe(true);
  });

  it('records a reply raw and decodes it in the manual layout, reporting each variant separately', async () => {
    // The manual's Set Parameters Response: ID 0D, channel 00, device 00, response ID 00, type 06, result 00.
    // Checksum: 0D + 06 = 19; 128 - 19 = 109 = 0x6D.
    const setResponse = [0xf0, 0x0d, 0x00, 0x00, 0x00, 0x06, 0x00, 0x6d, 0xf7];
    const port = new ScriptedPort(
      ALL_VARIANTS.map((expect) => ({ expect, reply: expect === SET_0D_DEVICE_00 ? [setResponse] : [] })),
    );

    const report = await runProbe(documentedCommandsProbe, { port, channel: 1, timeoutMs: 10 });

    expect(report.verdict).toBe('confirmed');
    const answered = report.data?.filter((variant) => variant.reply !== undefined);
    expect(answered).toEqual([
      {
        message: 'Set Parameters',
        manufacturerId: 0x0d,
        device: 0x00,
        sent: 'F0 0D 00 00 06 7F 01 02 00 6B F7',
        reply: 'F0 0D 00 00 00 06 00 6D F7',
        decoded: 'ID 0D, channel 1, device 00, response to 06, data 00, checksum OK',
      },
    ]);
  });
});
