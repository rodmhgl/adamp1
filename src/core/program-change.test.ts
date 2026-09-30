import { describe, expect, it } from 'vitest';
import { parseProgramChange, programChange } from './program-change.js';

describe('Program Change', () => {
  it('carries External Program Number 1 as 00 on the wire, on the status byte channel', () => {
    // C0 is Program Change on MIDI channel 1; C2 on channel 3.
    expect([...programChange(0, 1)]).toEqual([0xc0, 0x00]);
    expect([...programChange(2, 128)]).toEqual([0xc2, 0x7f]);
  });

  it('reads a received Program Change back as a 0-based channel and an External Program Number', () => {
    expect(parseProgramChange([0xc5, 0x09])).toEqual({ channel: 5, externalProgramNumber: 10 });
  });

  it('ignores anything that is not a Program Change', () => {
    expect(parseProgramChange([0xb0, 0x07, 0x40])).toBeUndefined(); // Control Change
    expect(parseProgramChange([0xf0, 0x0d, 0x00, 0x08, 0x01, 0x6a, 0xf7])).toBeUndefined();
    expect(parseProgramChange([0xc0])).toBeUndefined();
  });
});
