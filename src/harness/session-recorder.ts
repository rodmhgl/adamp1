import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PARAMETER_NAMES } from '../core/program.js';
import { hexBytes } from '../core/sysex.js';
import type { ReceivedMemoryImage, SavedBackup, TrafficEntry } from './probe-runner.js';

/**
 * Writes one session's evidence to its own folder:
 * - `capture.log`: every MIDI message sent and received, timestamped, byte by byte
 * - `report.json`: the machine-readable session report
 * - `memory-image-<n>.syx` and `memory-image-<n>.json`: each Memory Image backup,
 *   as the 0B frame exactly as received and decoded into 128 Programs in Memory order
 *
 * Writes are synchronous and immediate, so an aborted session still leaves
 * everything up to the abort on disk.
 */
export class SessionRecorder {
  private readonly captureLogPath: string;
  private readonly reportPath: string;
  private memoryImages = 0;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.captureLogPath = join(dir, 'capture.log');
    this.reportPath = join(dir, 'report.json');
    writeFileSync(this.captureLogPath, `# ADA MP-1 protocol harness capture log, started ${new Date().toISOString()}\n`);
  }

  heading(text: string): void {
    appendFileSync(this.captureLogPath, `${new Date().toISOString()}  --- ${text}\n`);
  }

  message(direction: TrafficEntry['direction'], bytes: ArrayLike<number>, timestamp: number): void {
    const line = `${wallClock(timestamp)}  ${direction.padEnd(8)} ${String(bytes.length).padStart(4)} bytes  ${hexBytes(bytes)}`;
    appendFileSync(this.captureLogPath, `${line}\n`);
  }

  writeReport(report: unknown): void {
    writeFileSync(this.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  saveMemoryImage({ image, syx }: ReceivedMemoryImage): SavedBackup {
    this.memoryImages += 1;
    const saved = {
      syxFile: `memory-image-${this.memoryImages}.syx`,
      decodedFile: `memory-image-${this.memoryImages}.json`,
    };
    writeFileSync(join(this.dir, saved.syxFile), syx);
    // One Memory per line, so the file reads as a table and diffs line by line.
    const memories = image.programs.map((program, i) => JSON.stringify({ memory: i + 1, raw: program.raw }));
    writeFileSync(
      join(this.dir, saved.decodedFile),
      `{\n  "parameters": ${JSON.stringify(PARAMETER_NAMES)},\n  "memories": [\n    ${memories.join(',\n    ')}\n  ]\n}\n`,
    );
    return saved;
  }
}

/** A `performance.now()` timestamp, as MIDI messages carry, as an ISO wall-clock time. */
export function wallClock(timestamp: number): string {
  return new Date(performance.timeOrigin + timestamp).toISOString();
}
