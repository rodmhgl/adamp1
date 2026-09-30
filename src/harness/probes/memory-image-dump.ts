import { MEMORY_COUNT, memoryImageRequest, parseMemoryImageSyx } from '../../core/memory-image.js';
import { PROGRAM_LENGTH } from '../../core/program.js';
import { isAdaSysEx } from '../../core/sysex.js';
import type { Probe, SavedBackup } from '../probe-runner.js';

export interface MemoryImageDumpResult {
  /** From sending the request to the whole Memory Image arriving. */
  durationMs: number;
  backup: SavedBackup;
}

/**
 * Requests the Memory Image (command 0A), checks the 0B reply's length and checksum,
 * times the transfer, and saves a valid Memory Image as the session's backup. Nothing is written to the unit.
 */
export const memoryImageDumpProbe: Probe<MemoryImageDumpResult> = {
  name: 'memory-image-dump',
  kind: 'non-destructive',
  async run({ wireChannel, dumpTimeoutMs, request, saveBackup }) {
    const sentAt = performance.now();
    // Take any ADA SysEx as the reply, so one in an unexpected layout is rejected instead of timing out,
    // while stray SysEx from other devices on the same input is ignored.
    const reply = await request(memoryImageRequest(wireChannel), isAdaSysEx, dumpTimeoutMs);

    if (!reply) {
      return {
        verdict: 'inconclusive',
        summary: `No reply to the Memory Image request within ${dumpTimeoutMs} ms.`,
        findings: [
          'Run the connectivity probe first to check the channel and cabling.',
          'If the unit does answer the Working Register request, the transfer may take longer than expected: raise --dump-timeout.',
          'An interface that drops or cuts off long SysEx messages also shows up as no reply: try another USB-MIDI interface.',
        ],
      };
    }

    const durationMs = Math.round(reply.timestamp - sentAt);
    const received = `Received ${reply.bytes.length} bytes after ${durationMs} ms`;
    const parsed = parseMemoryImageSyx(reply.bytes);
    if (!parsed.ok) {
      const lengthError = parsed.error === 'truncated' || parsed.error === 'too-long';
      // A wrong length with a matching checksum is what the unit really sent; anything else may be a corrupted transfer.
      const refuted = parsed.error === 'malformed' || (lengthError && parsed.checksumMatches === true);
      const reason = {
        truncated: 'is truncated',
        'too-long': 'is too long',
        'checksum-mismatch': 'fails its checksum',
        malformed: 'is not in the expected Memory Image format',
      }[parsed.error];
      return {
        verdict: refuted ? 'refuted' : 'inconclusive',
        summary: `The Memory Image reply ${reason}, so it was not kept as a backup.`,
        findings: [
          `${received}: ${parsed.detail}.`,
          ...(lengthError && parsed.checksumMatches !== undefined
            ? [parsed.checksumMatches ? 'The checksum matches, so the unit sent this length.' : 'The checksum does not match either.']
            : []),
        ],
      };
    }
    if (parsed.channel !== wireChannel) {
      return {
        verdict: 'inconclusive',
        summary: 'The unit replied with a valid Memory Image, but not on the channel it was asked on, so it was not kept as a backup.',
        findings: [`${received}: reply is on channel ${parsed.channel + 1}, requested on channel ${wireChannel + 1}.`],
      };
    }

    const backup = saveBackup({ image: parsed.image, syx: reply.bytes });
    return {
      verdict: 'confirmed',
      summary: `The unit answered a Memory Image request with ${MEMORY_COUNT} Programs, and saved it as this session's backup.`,
      findings: [
        `${received}: checksum matches, ${MEMORY_COUNT} Programs of ${PROGRAM_LENGTH} values. The dump took ${durationMs} ms.`,
        `Saved the Memory Image as received to ${backup.syxFile} and decoded to ${backup.decodedFile}.`,
      ],
      data: { durationMs, backup },
    };
  },
};
