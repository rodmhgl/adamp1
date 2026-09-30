import { describeProgram, PROGRAM_LENGTH, programDifferences, type ParameterDifference, type Program } from '../../core/program.js';
import type { Probe } from '../probe-runner.js';
import { readWorkingRegister, withWorkingRegisterRestored, writeWorkingRegister } from './working-register-steps.js';

/**
 * The known Program written to the Working Register, in unit byte order. Values are modest,
 * within the manual's ranges: Overdrive 1 10, Overdrive 2 20, Master Gain 16 (4.0), Bass 3,
 * Midrange 4, Treble 5, Presence 6, Effects Loop 0 (Out), Chorus Depth 50, Chorus Rate 25,
 * Voicing 1 (Distortion Tube in the manual's map).
 */
export const WRITE_TEST_PROGRAM: readonly number[] = [10, 20, 16, 3, 4, 5, 6, 0, 50, 25, 1];

export interface WriteReadBack {
  wrote: readonly number[];
  readBack: readonly number[];
  differences: ParameterDifference[];
}

/**
 * Writes a known Program to the Working Register (command 09 addressed to 7F), reads it
 * back and compares, then restores the Program that was sounding. No Memory is written.
 */
export const workingRegisterWriteProbe: Probe<WriteReadBack> = {
  name: 'working-register-write',
  kind: 'writes-working-register',
  run: (context) =>
    withWorkingRegisterRestored<WriteReadBack>(context, async (original) => {
      const wrote: Program = { raw: WRITE_TEST_PROGRAM };
      const findings = await writeWorkingRegister(context, wrote);
      const unchanged = programDifferences(original, wrote).length === 0;
      if (unchanged) findings.push('The test Program was already sounding, so the read-back cannot show the write took.');

      const after = await readWorkingRegister(context);
      if (!after.ok) {
        return {
          verdict: 'inconclusive',
          summary: 'The Program was written, but the Working Register could not be read back.',
          findings: [...findings, after.finding],
        };
      }

      const diff = programDifferences(wrote, after.program);
      const data = { wrote: wrote.raw, readBack: after.program.raw, differences: diff };
      findings.push(`Wrote ${describeProgram(wrote)}.`, `Read back ${describeProgram(after.program)}.`);
      if (diff.length > 0) {
        return {
          verdict: 'refuted',
          summary: `The Working Register read back differs from the Program written in ${diff.length} of ${PROGRAM_LENGTH} parameters.`,
          findings: [...findings, ...diff.map(({ name, wrote, readBack }) => `${name}: wrote ${wrote}, read back ${readBack}.`)],
          data,
        };
      }
      return {
        verdict: unchanged ? 'inconclusive' : 'confirmed',
        summary: `The Working Register read back matches the Program written, in all ${PROGRAM_LENGTH} parameters.`,
        findings,
        data,
      };
    }),
};
