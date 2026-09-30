/**
 * MP-1 SysEx framing. Every layout here is a hypothesis about v2.x firmware that
 * the protocol harness confirms against a real unit (ADR 0002), not the manual's layout:
 *
 *   F0 0D <channel, 0-based> <command> 01 <payload…> <checksum> F7
 *
 * The checksum is the 7-bit two's complement of the sum of every byte after F0
 * up to the last payload byte.
 */

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
export const ADA_MANUFACTURER_ID = 0x0d;
/** Constant byte seen after the command in every known frame. Its meaning is unknown. */
const FIXED_BYTE = 0x01;

/** Bytes before the payload (F0, ID, channel, command, fixed byte) and after it (checksum, F7). */
const HEADER_LENGTH = 5;
const TRAILER_LENGTH = 2;

export interface Frame {
  /** 0-based: MIDI channel 1 is 0. */
  channel: number;
  command: number;
  payload: readonly number[];
}

export type ParsedFrame =
  | { ok: true; frame: Frame }
  | { ok: false; error: 'not-an-mp1-frame'; detail: string }
  | {
      ok: false;
      error: 'checksum-mismatch';
      detail: string;
      frame: Frame;
      expectedChecksum: number;
      actualChecksum: number;
    };

export function checksum(bytes: readonly number[]): number {
  const sum = bytes.reduce((total, byte) => total + byte, 0);
  return (128 - (sum % 128)) % 128;
}

export function buildFrame({ channel, command, payload }: Frame): Uint8Array {
  const body = [ADA_MANUFACTURER_ID, channel, command, FIXED_BYTE, ...payload];
  return Uint8Array.from([SYSEX_START, ...body, checksum(body), SYSEX_END]);
}

export function isSysEx(bytes: ArrayLike<number>): boolean {
  return bytes.length > 0 && bytes[0] === SYSEX_START;
}

export function parseFrame(bytes: ArrayLike<number>): ParsedFrame {
  const all = Array.from(bytes);
  const reject = (detail: string): ParsedFrame => ({ ok: false, error: 'not-an-mp1-frame', detail });

  if (all.length < HEADER_LENGTH + TRAILER_LENGTH) return reject(`only ${all.length} bytes`);
  if (all[0] !== SYSEX_START || all[all.length - 1] !== SYSEX_END) return reject('not a SysEx message');
  if (all[1] !== ADA_MANUFACTURER_ID) return reject(`manufacturer ID is ${hex(all[1])}, not ${hex(ADA_MANUFACTURER_ID)}`);
  if (all[4] !== FIXED_BYTE) return reject(`byte 4 is ${hex(all[4])}, not ${hex(FIXED_BYTE)}`);

  const body = all.slice(1, -TRAILER_LENGTH);
  const frame: Frame = {
    channel: all[2]!,
    command: all[3]!,
    payload: all.slice(HEADER_LENGTH, -TRAILER_LENGTH),
  };
  const expectedChecksum = checksum(body);
  const actualChecksum = all[all.length - TRAILER_LENGTH]!;
  if (expectedChecksum !== actualChecksum) {
    return {
      ok: false,
      error: 'checksum-mismatch',
      detail: `checksum mismatch: received ${hex(actualChecksum)}, computed ${hex(expectedChecksum)}`,
      frame,
      expectedChecksum,
      actualChecksum,
    };
  }
  return { ok: true, frame };
}

export function hex(byte: number | undefined): string {
  return byte === undefined ? '--' : byte.toString(16).toUpperCase().padStart(2, '0');
}

export function hexBytes(bytes: ArrayLike<number>): string {
  return Array.from(bytes, hex).join(' ');
}
