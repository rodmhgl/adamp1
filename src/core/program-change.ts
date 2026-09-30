/**
 * MIDI Program Change: status C0–CF (low nibble the 0-based channel), then one data byte.
 * The data byte is the External Program Number minus one; the unit's MIDI Map then
 * translates the External Program Number to a Memory.
 */

const PROGRAM_CHANGE = 0xc0;

export interface ProgramChange {
  /** 0-based: MIDI channel 1 is 0. */
  channel: number;
  /** 1–128. */
  externalProgramNumber: number;
}

/** `channel` is 0-based, as on the wire. */
export function programChange(channel: number, externalProgramNumber: number): Uint8Array {
  return Uint8Array.from([PROGRAM_CHANGE | channel, externalProgramNumber - 1]);
}

export function parseProgramChange(bytes: ArrayLike<number>): ProgramChange | undefined {
  if (bytes.length !== 2 || (bytes[0]! & 0xf0) !== PROGRAM_CHANGE) return undefined;
  return { channel: bytes[0]! & 0x0f, externalProgramNumber: bytes[1]! + 1 };
}
