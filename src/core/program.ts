/**
 * A Program: the eleven MP-1 parameter values, raw, in unit byte order.
 * The order (Overdrive 1 first) is a hypothesis the harness confirms (ADR 0002);
 * the manual's map puts Overdrive 2 first and is believed wrong.
 * Display Values are not modelled yet: calibration will supply them.
 */

export const PARAMETER_NAMES = [
  'Overdrive 1',
  'Overdrive 2',
  'Master Gain',
  'Bass',
  'Midrange',
  'Treble',
  'Presence',
  'Effects Loop',
  'Chorus Depth',
  'Chorus Rate',
  'Voicing',
] as const;

export type ParameterName = (typeof PARAMETER_NAMES)[number];

export const PROGRAM_LENGTH = PARAMETER_NAMES.length;

/** Largest value a SysEx data byte can carry. Real per-parameter ranges await calibration. */
const MAX_RAW_VALUE = 0x7f;

export interface Program {
  readonly raw: readonly number[];
}

export interface NamedRawValue {
  name: ParameterName;
  raw: number;
}

export type ParsedProgram = { ok: true; program: Program } | { ok: false; detail: string };

export function parseProgram(bytes: readonly number[]): ParsedProgram {
  if (bytes.length !== PROGRAM_LENGTH) {
    return { ok: false, detail: `a Program has ${PROGRAM_LENGTH} values, got ${bytes.length}` };
  }
  const outOfRange = bytes.findIndex((value) => !Number.isInteger(value) || value < 0 || value > MAX_RAW_VALUE);
  if (outOfRange !== -1) {
    return { ok: false, detail: `${PARAMETER_NAMES[outOfRange]} has raw value ${bytes[outOfRange]}, outside 0–${MAX_RAW_VALUE}` };
  }
  return { ok: true, program: { raw: [...bytes] } };
}

export function namedRawValues(program: Program): NamedRawValue[] {
  return PARAMETER_NAMES.map((name, i) => ({ name, raw: program.raw[i]! }));
}
