import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hexBytes } from '../core/sysex.js';
import type { TrafficEntry } from './probe-runner.js';

/**
 * Writes one session's evidence to its own folder:
 * - `capture.log`: every MIDI message sent and received, timestamped, byte by byte
 * - `report.json`: the machine-readable session report
 *
 * Writes are synchronous and immediate, so an aborted session still leaves
 * everything up to the abort on disk.
 */
export class SessionRecorder {
  private readonly captureLogPath: string;
  private readonly reportPath: string;

  constructor(dir: string) {
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
}

/** A `performance.now()` timestamp, as MIDI messages carry, as an ISO wall-clock time. */
export function wallClock(timestamp: number): string {
  return new Date(performance.timeOrigin + timestamp).toISOString();
}
