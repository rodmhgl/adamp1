import { MEMORY_COUNT, memoryImageDifferences, type MemoryDifference, type MemoryImage } from '../../core/memory-image.js';
import { describeFailedRead, describeMemoryDifferences } from '../memory-image-transfer.js';
import type { Probe } from '../probe-runner.js';

export interface MemoryImageLoadResult {
  /** How many Memories the test image changed against the backup. */
  changedMemories: number;
  /** Every Memory that read back differently from the test image. */
  differences: MemoryDifference[];
}

/**
 * Loads a Memory Image (command 0B), dumps it back and compares. The image loaded is the
 * session's backup with its Memories rotated by one (Memory n gets Memory n + 1, Memory 128
 * gets Memory 1), so every Memory that can change does, using only Programs the unit already
 * held. The runner then loads the backup back and checks it.
 */
export const memoryImageLoadProbe: Probe<MemoryImageLoadResult> = {
  name: 'memory-image-load',
  kind: 'writes-memories',
  async run({ backup, loadMemoryImage, readMemoryImage }) {
    const saved = backup()!;
    const testImage = rotated(saved.image);
    const changedMemories = memoryImageDifferences(saved.image, testImage).length;
    if (changedMemories === 0) {
      return {
        verdict: 'inconclusive',
        summary: 'Every Memory holds the same Program, so a load could not be told apart from no load; nothing was written.',
        findings: [],
      };
    }

    const findings = await loadMemoryImage(testImage);
    findings.push(`Loaded the backup ${saved.syxFile} with its Memories rotated by one, changing ${changedMemories} of ${MEMORY_COUNT} Memories.`);

    const read = await readMemoryImage();
    if (!read.ok) {
      return {
        verdict: 'inconclusive',
        summary: 'The Memory Image was loaded, but could not be dumped back to compare.',
        findings: [...findings, describeFailedRead(read)],
      };
    }

    const differences = memoryImageDifferences(testImage, read.image);
    const data = { changedMemories, differences };
    if (memoryImageDifferences(saved.image, read.image).length === 0) {
      return {
        verdict: 'inconclusive',
        summary: 'The unit ignored the load: it still holds the backup.',
        findings: [...findings, 'Check that Protect is OFF, and that the interface passes long SysEx messages.'],
        data,
      };
    }
    if (differences.length > 0) {
      return {
        verdict: 'refuted',
        summary: `The dump read back after the load differs from the loaded Memory Image in ${differences.length} of ${MEMORY_COUNT} Memories.`,
        findings: [...findings, ...describeMemoryDifferences(differences)],
        data,
      };
    }
    return {
      verdict: 'confirmed',
      summary: `The dump read back after the load matches the loaded Memory Image in all ${MEMORY_COUNT} Memories: the round trip is lossless.`,
      findings,
      data,
    };
  },
};

function rotated(image: MemoryImage): MemoryImage {
  return { programs: [...image.programs.slice(1), image.programs[0]!] };
}
