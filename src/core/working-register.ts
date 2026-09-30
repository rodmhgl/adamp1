/**
 * Working Register messages. Hypotheses (ADR 0002): command 08 requests the
 * Working Register; the unit replies with command 09 carrying address 7F
 * followed by one Program. The same 09 frame sent to the unit sets the Working Register.
 */
import { parseProgram, type Program } from './program.js';
import { buildFrame, hex, parseFrame } from './sysex.js';

const REQUEST_WORKING_REGISTER = 0x08;
const PROGRAM_DATA = 0x09;
const WORKING_REGISTER_ADDRESS = 0x7f;

export type WorkingRegisterReply =
  | { ok: true; channel: number; program: Program }
  | { ok: false; error: 'checksum-mismatch' | 'malformed'; detail: string };

/** `channel` is 0-based, as on the wire. */
export function workingRegisterRequest(channel: number): Uint8Array {
  return buildFrame({ channel, command: REQUEST_WORKING_REGISTER, payload: [] });
}

/** Sets the Working Register to `program`. `channel` is 0-based, as on the wire. */
export function workingRegisterWrite(channel: number, program: Program): Uint8Array {
  return buildFrame({ channel, command: PROGRAM_DATA, payload: [WORKING_REGISTER_ADDRESS, ...program.raw] });
}

export function parseWorkingRegisterReply(bytes: ArrayLike<number>): WorkingRegisterReply {
  const parsed = parseFrame(bytes);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error === 'checksum-mismatch' ? 'checksum-mismatch' : 'malformed', detail: parsed.detail };
  }
  const { channel, command, payload } = parsed.frame;
  if (command !== PROGRAM_DATA) {
    return { ok: false, error: 'malformed', detail: `command is ${hex(command)}, not ${hex(PROGRAM_DATA)}` };
  }
  const [address, ...values] = payload;
  if (address !== WORKING_REGISTER_ADDRESS) {
    return { ok: false, error: 'malformed', detail: `addressed to ${hex(address)}, not ${hex(WORKING_REGISTER_ADDRESS)} (Working Register)` };
  }
  const program = parseProgram(values);
  if (!program.ok) return { ok: false, error: 'malformed', detail: program.detail };
  return { ok: true, channel, program: program.program };
}
