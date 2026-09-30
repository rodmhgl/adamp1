import { MEMORY_COUNT, memoryImageDifferences, type MemoryImage } from '../../core/memory-image.js';
import { describeFailedRead, describeMemoryDifferences } from '../memory-image-transfer.js';
import type { Probe, SavedBackup } from '../probe-runner.js';

/**
 * Loads a saved Memory Image (`file` names it in the evidence) and checks it with a dump.
 * A restore that reads back as the file becomes the session's backup; one that doesn't
 * is undone by the runner, which loads back what the unit held before.
 */
export function restoreProbe(file: string, image: MemoryImage): Probe<SavedBackup> {
  return {
    name: 'restore',
    kind: 'writes-memories',
    async run({ loadMemoryImage, readMemoryImage, saveBackup }) {
      const { findings } = await loadMemoryImage(image);
      findings.push(`Loaded ${file}.`);

      const read = await readMemoryImage();
      if (!read.ok) {
        return {
          verdict: 'inconclusive',
          summary: `${file} was loaded, but could not be dumped back to check it.`,
          findings: [...findings, describeFailedRead(read)],
        };
      }
      const differences = memoryImageDifferences(image, read.image);
      if (differences.length > 0) {
        return {
          verdict: 'refuted',
          summary: `The unit reads back differently from ${file} in ${differences.length} of ${MEMORY_COUNT} Memories.`,
          findings: [...findings, ...describeMemoryDifferences(differences)],
        };
      }

      const backup = saveBackup(read);
      return {
        verdict: 'confirmed',
        summary: `Restored ${file}: the dump read back matches it in all ${MEMORY_COUNT} Memories.`,
        findings: [...findings, `Saved the restored Memory Image as the session's backup ${backup.syxFile}.`],
        data: backup,
      };
    },
  };
}
