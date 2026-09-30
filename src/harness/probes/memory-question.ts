import { MEMORY_COUNT } from '../../core/memory-image.js';
import type { Operator } from '../operator.js';

export interface MemoryAnswer {
  /** 1–128, when the maintainer entered a Memory number. */
  memory?: number;
  /** What the maintainer entered, for evidence: "Memory 5", or e.g. "OUT" (not a Memory number). */
  reading: string;
}

/** Asks the maintainer which Memory the display shows. Anything but 1–128 (such as OUT) is kept as evidence only. */
export async function askMemory(operator: Operator, question: string): Promise<MemoryAnswer> {
  const entered = (
    await operator.ask(
      `${question} (With the PRGM or MEM LED lit, MIDI is disabled and the display shows other numbers: leave those modes first.) ` +
        `Enter the Memory number (1-${MEMORY_COUNT}), or what the display reads`,
    )
  ).trim();
  const memory = Number(entered);
  if (/^\d+$/.test(entered) && memory >= 1 && memory <= MEMORY_COUNT) {
    return { memory, reading: `Memory ${memory}` };
  }
  return { reading: `"${entered}" (not a Memory number)` };
}
