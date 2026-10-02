import { MEMORY_COUNT, memoryImageDifferences, memoryImageSyx, rotatedByOne, type MemoryImage } from '../../core/memory-image.js';
import { describeFailedRead } from '../memory-image-transfer.js';
import type { Pacing, Probe } from '../probe-runner.js';

export interface LoadPacingOptions {
  /** Bytes per chunk; `'whole'` sends the load as one message. */
  chunkSizes: readonly (number | 'whole')[];
  /** Pause between chunks. */
  delaysMs: readonly number[];
  /** Loads per setting. */
  repeats: number;
}

export interface PacingSetting extends Pacing {
  /** Chunks per load. */
  chunks: number;
  /** The pauses alone, the least time a load takes: what "fastest" ranks by. */
  minLoadMs: number;
  attempts: number;
  /** Loads that read back as the Memory Image loaded. */
  successes: number;
}

export interface LoadPacingResult {
  settings: PacingSetting[];
  /** The fastest setting that read back correctly every time, if any. */
  fastest?: Pacing;
}

/**
 * Loads Memory Images (command 0B) in chunks of each size, with each pause between chunks,
 * several times per setting, and checks every load with a dump. Loads alternate between the
 * backup rotated by one and the backup itself, so a load the unit loses never reads back as
 * a success. Reports each setting's success rate and the fastest one that never failed.
 * At the end, the backup is loaded back with that setting (or the slowest tried) if needed;
 * the runner falls back on a whole-message restore.
 */
export function loadPacingProbe({ chunkSizes, delaysMs, repeats }: LoadPacingOptions): Probe<LoadPacingResult> {
  return {
    name: 'load-pacing',
    kind: 'writes-memories',
    async run({ backup, beginMemoryImageLoads, readMemoryImage }) {
      const saved = backup()!;
      const rotated = rotatedByOne(saved.image);
      if (memoryImageDifferences(saved.image, rotated).length === 0) {
        return {
          verdict: 'inconclusive',
          summary: 'Every Memory holds the same Program, so a load could not be told apart from no load; nothing was written.',
          findings: [],
        };
      }

      const settings = pacingSettings(memoryImageSyx(0, saved.image).length, chunkSizes, delaysMs);
      const load = await beginMemoryImageLoads([rotated, saved.image], settings.length * repeats + 1);
      const findings: string[] = [];
      const other = (image: MemoryImage) => (image === rotated ? saved.image : rotated);
      let next = rotated;
      let unitHoldsBackup = true;

      for (const setting of settings) {
        for (let attempt = 1; attempt <= repeats; attempt++) {
          const image = next;
          const answer = await load(image, setting);
          findings.push(...answer.findings);
          setting.attempts++;
          const read = await readMemoryImage();
          const failed = `Load ${attempt} of ${repeats} with ${describePacing(setting)}`;
          if (!read.ok) {
            findings.push(`${failed} could not be checked: ${describeFailedRead(read)}`);
            // Whether it landed decides the next load: one the unit already holds would read back as a success, lost or not.
            const reread = await readMemoryImage();
            unitHoldsBackup = reread.ok && memoryImageDifferences(saved.image, reread.image).length === 0;
            if (reread.ok && memoryImageDifferences(image, reread.image).length === 0) next = other(image);
            else if (!reread.ok) findings.push(`The dump read again to find what the unit holds failed too: ${describeFailedRead(reread)}`);
            continue;
          }
          unitHoldsBackup = memoryImageDifferences(saved.image, read.image).length === 0;
          const differences = memoryImageDifferences(image, read.image).length;
          if (differences === 0) {
            setting.successes++;
            next = other(image);
          } else if (memoryImageDifferences(other(image), read.image).length === 0) {
            findings.push(`${failed} was lost: the unit still held the image from before.`);
          } else {
            findings.push(`${failed} read back differently in ${differences} of ${MEMORY_COUNT} Memories.`);
            next = other(image);
          }
        }
      }

      const fastest = settings
        .filter(({ successes, attempts }) => successes === attempts)
        .sort((a, b) => a.minLoadMs - b.minLoadMs || a.chunks - b.chunks)[0];
      const data: LoadPacingResult = { settings, ...(fastest && { fastest: pacingOf(fastest) }) };
      const rates = settings.map(
        (setting) =>
          `${describePacing(setting)} (${setting.chunks} ${setting.chunks === 1 ? 'chunk' : 'chunks'}, at least ${setting.minLoadMs} ms per load): ` +
          `${setting.successes} of ${setting.attempts} loads read back correctly (${Math.round((100 * setting.successes) / setting.attempts)}%).`,
      );

      if (!unitHoldsBackup) {
        const slowest = [...settings].sort((a, b) => b.minLoadMs - a.minLoadMs || b.chunks - a.chunks)[0]!;
        const pacing = fastest ?? slowest;
        await load(saved.image, pacing);
        const read = await readMemoryImage();
        const loaded = `Loaded the backup ${saved.syxFile} back with ${describePacing(pacing)}`;
        if (!read.ok) findings.push(`${loaded}, but could not check it: ${describeFailedRead(read)}`);
        else if (memoryImageDifferences(saved.image, read.image).length === 0) findings.push(`${loaded}: the dump read back matches it.`);
        else findings.push(`${loaded}, but the dump read back differs from it.`);
      }

      const tried = `${settings.length} ${settings.length === 1 ? 'setting' : 'settings'}, ${repeats} ${repeats === 1 ? 'load' : 'loads'} each`;
      if (!fastest) {
        return {
          verdict: 'inconclusive',
          summary: `None of the ${tried} was fully reliable; try smaller chunks or longer pauses.`,
          findings: [...rates, ...findings],
          data,
        };
      }
      return {
        verdict: 'confirmed',
        summary: `Of ${tried}, the fastest with a 100% success rate is ${describePacing(fastest)}.`,
        findings: [...rates, ...findings],
        data,
      };
    },
  };
}

/** Every chunk size with every delay, in that order. Chunks as long as the load send it whole, so their delay doesn't matter. */
function pacingSettings(loadBytes: number, chunkSizes: LoadPacingOptions['chunkSizes'], delaysMs: readonly number[]): PacingSetting[] {
  const settings = new Map<string, PacingSetting>();
  for (const size of chunkSizes) {
    for (const delay of delaysMs) {
      const chunkBytes = size === 'whole' ? loadBytes : Math.min(size, loadBytes);
      const delayMs = chunkBytes === loadBytes ? 0 : delay;
      const chunks = Math.ceil(loadBytes / chunkBytes);
      const key = `${chunkBytes}/${delayMs}`;
      if (!settings.has(key)) settings.set(key, { chunkBytes, delayMs, chunks, minLoadMs: (chunks - 1) * delayMs, attempts: 0, successes: 0 });
    }
  }
  return [...settings.values()];
}

function pacingOf({ chunkBytes, delayMs }: Pacing): Pacing {
  return { chunkBytes, delayMs };
}

function describePacing(setting: Pacing & { chunks?: number }): string {
  return setting.chunks === 1 ? 'the whole message at once' : `${setting.chunkBytes}-byte chunks, ${setting.delayMs} ms apart`;
}
