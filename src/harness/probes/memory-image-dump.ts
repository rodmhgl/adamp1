import { MEMORY_COUNT } from '../../core/memory-image.js';
import { PROGRAM_LENGTH } from '../../core/program.js';
import { describeFailedRead, type MemoryImageRead } from '../memory-image-transfer.js';
import type { Probe, ProbeOutcome, SavedBackup } from '../probe-runner.js';

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
  async run({ readMemoryImage, saveBackup }) {
    const read = await readMemoryImage();
    if (!read.ok) return failedDump(read);

    const { durationMs } = read;
    const backup = saveBackup(read);
    return {
      verdict: 'confirmed',
      summary: `The unit answered a Memory Image request with ${MEMORY_COUNT} Programs, and saved it as this session's backup.`,
      findings: [
        `Received ${read.syx.length} bytes after ${durationMs} ms: checksum matches, ${MEMORY_COUNT} Programs of ${PROGRAM_LENGTH} values. The dump took ${durationMs} ms.`,
        `Saved the Memory Image as received to ${backup.syxFile} and decoded to ${backup.decodedFile}.`,
      ],
      data: { durationMs, backup },
    };
  },
};

function failedDump(read: Exclude<MemoryImageRead, { ok: true }>): ProbeOutcome<never> {
  if (read.error === 'no-reply') {
    return {
      verdict: 'inconclusive',
      summary: `No reply to the Memory Image request within ${read.timeoutMs} ms.`,
      findings: [
        'Run the connectivity probe first to check the channel and cabling.',
        'If the unit does answer the Working Register request, the transfer may take longer than expected: raise --dump-timeout.',
        'An interface that drops or cuts off long SysEx messages also shows up as no reply: try another USB-MIDI interface.',
      ],
    };
  }
  if (read.error === 'wrong-channel') {
    return {
      verdict: 'inconclusive',
      summary: 'The unit replied with a valid Memory Image, but not on the channel it was asked on, so it was not kept as a backup.',
      findings: [describeFailedRead(read)],
    };
  }

  const lengthError = read.error === 'truncated' || read.error === 'too-long';
  // A wrong length with a matching checksum is what the unit really sent; anything else may be a corrupted transfer.
  const refuted = read.error === 'malformed' || (lengthError && read.checksumMatches === true);
  const reason = {
    truncated: 'is truncated',
    'too-long': 'is too long',
    'checksum-mismatch': 'fails its checksum',
    malformed: 'is not in the expected Memory Image format',
  }[read.error];
  return {
    verdict: refuted ? 'refuted' : 'inconclusive',
    summary: `The Memory Image reply ${reason}, so it was not kept as a backup.`,
    findings: [
      describeFailedRead(read),
      ...(lengthError && read.checksumMatches !== undefined
        ? [read.checksumMatches ? 'The checksum matches, so the unit sent this length.' : 'The checksum does not match either.']
        : []),
    ],
  };
}
