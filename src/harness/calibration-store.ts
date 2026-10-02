import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ParameterName } from '../core/program.js';

/** What the LED showed for one raw value during Display Value calibration. */
export interface CalibrationEntry {
  raw: number;
  /** Exactly what the maintainer typed; null when they skipped the value. */
  displayValue: string | null;
  /** The parameter's raw value read back from the Working Register; null when it couldn't be read. */
  readBack: number | null;
}

/** Where calibration is kept between sessions, so an interrupted calibration can resume. */
export interface CalibrationStore {
  /** The entries recorded so far for `parameter`, in the order they were recorded. */
  load(parameter: ParameterName): CalibrationEntry[];
  /** Replaces the entries for `parameter`. */
  save(parameter: ParameterName, entries: readonly CalibrationEntry[]): void;
}

/**
 * Keeps every parameter's calibration in one JSON file, keyed by parameter name. Each save
 * rewrites the file at once, so an interrupted calibration loses at most the value on screen.
 */
export class FileCalibrationStore implements CalibrationStore {
  constructor(readonly path: string) {}

  load(parameter: ParameterName): CalibrationEntry[] {
    return this.read()[parameter] ?? [];
  }

  save(parameter: ParameterName, entries: readonly CalibrationEntry[]): void {
    const all = { ...this.read(), [parameter]: entries };
    mkdirSync(dirname(this.path), { recursive: true });
    // One entry per line, so the file reads as a table and diffs line by line.
    const body = Object.entries(all)
      .map(([name, rows]) => `  ${JSON.stringify(name)}: [${rows.map((row) => `\n    ${JSON.stringify(row)}`).join(',')}${rows.length > 0 ? '\n  ' : ''}]`)
      .join(',\n');
    writeFileSync(this.path, `{\n${body}\n}\n`);
  }

  private read(): Partial<Record<ParameterName, CalibrationEntry[]>> {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    return JSON.parse(text) as Partial<Record<ParameterName, CalibrationEntry[]>>;
  }
}
