import {
  memoryImageRequest,
  parseMemoryImageSyx,
  type MemoryDifference,
  type MemoryImage,
  type MemoryImageError,
} from '../core/memory-image.js';
import type { MidiMessage } from '../core/midi-port.js';
import { isAdaSysEx } from '../core/sysex.js';

export type MemoryImageRead =
  | { ok: true; image: MemoryImage; syx: Uint8Array; durationMs: number }
  | { ok: false; error: 'no-reply'; timeoutMs: number }
  | {
      ok: false;
      error: MemoryImageError | 'wrong-channel';
      detail: string;
      /** For a length error: whether the frame's checksum matched, i.e. whether the unit really sent that many bytes. */
      checksumMatches?: boolean;
      /** Length of the reply received. */
      bytes: number;
      durationMs: number;
    };

/** Sends a request and awaits the first accepted reply, as `ProbeContext.request` does. */
type Exchange = (request: Uint8Array, accept: (bytes: Uint8Array) => boolean, timeoutMs: number) => Promise<MidiMessage | undefined>;

/** Requests the Memory Image (command 0A) and checks the 0B reply's length, checksum and channel. */
export async function requestMemoryImage(exchange: Exchange, wireChannel: number, dumpTimeoutMs: number): Promise<MemoryImageRead> {
  const sentAt = performance.now();
  // Take any ADA SysEx as the reply, so one in an unexpected layout is rejected instead of timing out,
  // while stray SysEx from other devices on the same input is ignored.
  const reply = await exchange(memoryImageRequest(wireChannel), isAdaSysEx, dumpTimeoutMs);
  if (!reply) return { ok: false, error: 'no-reply', timeoutMs: dumpTimeoutMs };

  const durationMs = Math.round(reply.timestamp - sentAt);
  const parsed = parseMemoryImageSyx(reply.bytes);
  if (!parsed.ok) return { ...parsed, bytes: reply.bytes.length, durationMs };
  if (parsed.channel !== wireChannel) {
    return {
      ok: false,
      error: 'wrong-channel',
      detail: `reply is on channel ${parsed.channel + 1}, requested on channel ${wireChannel + 1}`,
      bytes: reply.bytes.length,
      durationMs,
    };
  }
  return { ok: true, image: parsed.image, syx: reply.bytes, durationMs };
}

/** One line on why a read failed, for evidence. */
export function describeFailedRead(read: Exclude<MemoryImageRead, { ok: true }>): string {
  if (read.error === 'no-reply') return `No reply to the Memory Image request within ${read.timeoutMs} ms.`;
  return `Received ${read.bytes} bytes after ${read.durationMs} ms: ${read.detail}.`;
}

/** One line per parameter that read back differently after a load, for evidence. */
export function describeMemoryDifferences(differences: readonly MemoryDifference[]): string[] {
  return differences.flatMap(({ memory, differences }) =>
    differences.map(({ name, wrote, readBack }) => `Memory ${memory}: ${name} loaded ${wrote}, read back ${readBack}.`),
  );
}
