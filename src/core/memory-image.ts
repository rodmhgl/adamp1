/**
 * Memory Image messages. Hypotheses (ADR 0002): command 0A requests the Memory Image;
 * the unit replies with command 0B carrying all 128 Programs, 11 values each, in Memory
 * order and with no address byte. The same 0B frame sent to the unit loads the Memory Image.
 */
import { parseProgram, programDifferences, PROGRAM_LENGTH, type ParameterDifference, type Program } from './program.js';
import { buildFrame, hex, parseFrame, SYSEX_END, SYSEX_START } from './sysex.js';

const REQUEST_MEMORY_IMAGE = 0x0a;
const MEMORY_IMAGE_DATA = 0x0b;

export const MEMORY_COUNT = 128;
export const MEMORY_IMAGE_PAYLOAD_LENGTH = MEMORY_COUNT * PROGRAM_LENGTH;

/** All 128 Memories: `programs[0]` is Memory 1. */
export interface MemoryImage {
  readonly programs: readonly Program[];
}

export type MemoryImageError = 'truncated' | 'too-long' | 'checksum-mismatch' | 'malformed';

export type ParsedMemoryImage =
  | { ok: true; channel: number; image: MemoryImage }
  | {
      ok: false;
      error: MemoryImageError;
      detail: string;
      /** For a length error: whether the frame's checksum matched, i.e. whether the unit really sent that many bytes. */
      checksumMatches?: boolean;
    };

/** `channel` is 0-based, as on the wire. */
export function memoryImageRequest(channel: number): Uint8Array {
  return buildFrame({ channel, command: REQUEST_MEMORY_IMAGE, payload: [] });
}

/** The 0B frame carrying `image`: what the unit sends as a dump and what a `.syx` file holds. */
export function memoryImageSyx(channel: number, image: MemoryImage): Uint8Array {
  return buildFrame({ channel, command: MEMORY_IMAGE_DATA, payload: memoryImagePayload(image) });
}

export function memoryImagePayload(image: MemoryImage): number[] {
  return image.programs.flatMap((program) => program.raw);
}

export type ParsedMemoryImagePayload =
  | { ok: true; image: MemoryImage }
  | { ok: false; error: Exclude<MemoryImageError, 'checksum-mismatch'>; detail: string };

export function memoryImageFromPayload(payload: readonly number[]): ParsedMemoryImagePayload {
  if (payload.length < MEMORY_IMAGE_PAYLOAD_LENGTH) {
    return { ok: false, error: 'truncated', detail: `${payload.length} of ${MEMORY_IMAGE_PAYLOAD_LENGTH} data bytes` };
  }
  if (payload.length > MEMORY_IMAGE_PAYLOAD_LENGTH) {
    return { ok: false, error: 'too-long', detail: `${payload.length} data bytes, expected ${MEMORY_IMAGE_PAYLOAD_LENGTH}` };
  }
  const programs: Program[] = [];
  for (let memory = 1; memory <= MEMORY_COUNT; memory++) {
    const start = (memory - 1) * PROGRAM_LENGTH;
    const program = parseProgram(payload.slice(start, start + PROGRAM_LENGTH));
    if (!program.ok) return { ok: false, error: 'malformed', detail: `Memory ${memory}: ${program.detail}` };
    programs.push(program.program);
  }
  return { ok: true, image: { programs } };
}

/** Parses a Memory Image dump, or the contents of a `.syx` file holding one. */
export function parseMemoryImageSyx(bytes: ArrayLike<number>): ParsedMemoryImage {
  const all = Array.from(bytes);
  if (all[0] === SYSEX_START && all[all.length - 1] !== SYSEX_END) {
    return { ok: false, error: 'truncated', detail: `${all.length} bytes with no closing F7` };
  }
  const parsed = parseFrame(all);
  if (!parsed.ok && parsed.error === 'not-an-mp1-frame') return { ok: false, error: 'malformed', detail: parsed.detail };

  const { channel, command, payload } = parsed.frame;
  if (command !== MEMORY_IMAGE_DATA) {
    return { ok: false, error: 'malformed', detail: `command is ${hex(command)}, not ${hex(MEMORY_IMAGE_DATA)}` };
  }
  const image = memoryImageFromPayload(payload);
  if (!image.ok && (image.error === 'truncated' || image.error === 'too-long')) {
    return { ...image, checksumMatches: parsed.ok };
  }
  if (!parsed.ok) return { ok: false, error: 'checksum-mismatch', detail: parsed.detail };
  if (!image.ok) return image;
  return { ok: true, channel, image: image.image };
}

export interface MemoryDifference {
  /** 1–128. */
  memory: number;
  differences: ParameterDifference[];
}

/** Every Memory whose Program read back differs from the one written, in Memory order. */
export function memoryImageDifferences(wrote: MemoryImage, readBack: MemoryImage): MemoryDifference[] {
  return wrote.programs.flatMap((program, i) => {
    const differences = programDifferences(program, readBack.programs[i]!);
    return differences.length === 0 ? [] : [{ memory: i + 1, differences }];
  });
}
