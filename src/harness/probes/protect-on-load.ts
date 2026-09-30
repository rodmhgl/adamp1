import { MEMORY_COUNT, memoryImageDifferences, rotatedByOne } from '../../core/memory-image.js';
import { hexBytes } from '../../core/sysex.js';
import { describeFailedRead, describeMemoryDifferences } from '../memory-image-transfer.js';
import type { Probe } from '../probe-runner.js';

/**
 * What the unit did with a Memory Image loaded while Protect was ON: ignored it without
 * a word, answered it, or wrote some or all of it anyway.
 */
export type ProtectOnLoadOutcome = 'silence' | 'error-reply' | 'partial-write' | 'full-write';

export interface ProtectOnLoadResult {
  outcome: ProtectOnLoadOutcome;
  /** The ADA SysEx the unit answered the load with, if any. */
  reply?: number[];
  /** Every Memory (1–128) that no longer holds the backup's Program. */
  changedMemories: number[];
}

/**
 * Asks for Protect ON, loads the backup with its Memories rotated by one, and dumps it
 * back to see what the unit did with it. When any Memory changed, the runner asks for
 * Protect OFF and loads the backup back. The editor uses the outcome to detect and
 * explain a refused load. The verdict tests the claim that Protect ON refuses the load:
 * silence or an error reply confirms it, and any Memory written refutes it.
 */
export const protectOnLoadProbe: Probe<ProtectOnLoadResult> = {
  name: 'protect-on-load',
  kind: 'writes-memories',
  async run({ backup, loadMemoryImage, readMemoryImage, timeoutMs }) {
    const saved = backup()!;
    const testImage = rotatedByOne(saved.image);
    const loadedChanges = memoryImageDifferences(saved.image, testImage).length;
    if (loadedChanges === 0) {
      return {
        verdict: 'inconclusive',
        summary: 'Every Memory holds the same Program, so a refused load could not be told apart from an accepted one; nothing was written.',
        findings: [],
      };
    }

    const { reply, findings } = await loadMemoryImage(testImage, { protectOn: true });
    findings.push(
      `Loaded the backup ${saved.syxFile} with its Memories rotated by one, changing ${loadedChanges} of ${MEMORY_COUNT} Memories, with Protect ON.`,
    );
    if (!reply) findings.push(`No reply within ${timeoutMs} ms of the load.`);

    const read = await readMemoryImage();
    if (!read.ok) {
      return {
        verdict: 'inconclusive',
        summary: 'The Memory Image was loaded with Protect ON, but could not be dumped back to see what the unit did with it.',
        findings: [...findings, describeFailedRead(read)],
      };
    }

    const changes = memoryImageDifferences(saved.image, read.image);
    const changedMemories = changes.map(({ memory }) => memory);
    const replyField = reply && { reply: [...reply.bytes] };

    if (changes.length === 0) {
      const data: ProtectOnLoadResult = { outcome: reply ? 'error-reply' : 'silence', ...replyField, changedMemories };
      const refusedFindings = [
        ...findings,
        `The dump read back after the load shows all ${MEMORY_COUNT} Memories still hold the backup.`,
        'Protect is left ON; the next load asks for it OFF.',
      ];
      return {
        verdict: 'confirmed',
        summary: reply
          ? `With Protect ON the unit refused the Memory Image, answering ${hexBytes(reply.bytes)}.`
          : 'With Protect ON the unit refused the Memory Image silently: no reply, and no Memory changed.',
        findings: refusedFindings,
        data,
      };
    }

    if (memoryImageDifferences(testImage, read.image).length === 0) {
      return {
        verdict: 'refuted',
        summary: 'With Protect ON the unit still accepted the whole Memory Image.',
        findings: [...findings, 'Check that Protect was ON: the unit behaved as with Protect OFF.'],
        data: { outcome: 'full-write', ...replyField, changedMemories },
      };
    }
    return {
      verdict: 'refuted',
      summary: `With Protect ON the unit partly wrote the Memory Image: ${changes.length} of ${MEMORY_COUNT} Memories changed.`,
      findings: [...findings, ...describeMemoryDifferences(changes, 'was')],
      data: { outcome: 'partial-write', ...replyField, changedMemories },
    };
  },
};
