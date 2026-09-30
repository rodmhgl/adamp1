/**
 * Hand-built MP-1 frames for tests that need many of them. The checksum is worked
 * out here, independently of the codec: the 7-bit two's complement of the sum of
 * every byte after F0 up to the last payload byte. connectivity.test.ts pins the
 * layout with fully hand-computed frames.
 */
function frame(wireChannel: number, command: number, payload: readonly number[]): number[] {
  const body = [0x0d, wireChannel, command, 0x01, ...payload];
  const sum = body.reduce((total, byte) => total + byte, 0);
  return [0xf0, ...body, (128 - (sum % 128)) % 128, 0xf7];
}

/** Command 08: request the Working Register. */
export function workingRegisterRequest(wireChannel: number): number[] {
  return frame(wireChannel, 0x08, []);
}

/** Command 09 addressed to 7F: a Program for the Working Register, sent either way. */
export function workingRegisterProgram(wireChannel: number, values: readonly number[]): number[] {
  return frame(wireChannel, 0x09, [0x7f, ...values]);
}
