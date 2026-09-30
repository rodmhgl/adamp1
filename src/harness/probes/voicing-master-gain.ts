import { rawValue, withRawValue } from '../../core/program.js';
import type { Probe } from '../probe-runner.js';
import { readWorkingRegister, withWorkingRegisterRestored, writeWorkingRegister } from './working-register-steps.js';

/** Non-zero but quiet: Display Value 1.0 in the manual's Master Gain table. */
const TEST_MASTER_GAIN = 10;
// Voicing raw values in the manual's map. Solid State (0) is avoided: it bypasses the tubes.
const DISTORTION_TUBE = 1;
const CLEAN_TUBE = 2;

export interface VoicingMasterGain {
  /** Whether Master Gain read back as 0 after the Voicing change. */
  reset: boolean;
  voicingBefore: number;
  voicingAfter: number;
  masterGainBefore: number;
  masterGainAfter: number;
}

/**
 * The front panel resets Master Gain to 0 whenever Voicing changes during an edit.
 * This probe sets a non-zero Master Gain in the Working Register, changes Voicing
 * through SysEx, reads the Working Register back and reports whether Master Gain was
 * reset, then restores the Program that was sounding. No Memory is written.
 *
 * The hypothesis under test is that the reset also happens over SysEx: "confirmed"
 * means Master Gain was reset. The editor's plan to preserve the user's Master Gain
 * depends on the answer.
 */
export const voicingMasterGainProbe: Probe<VoicingMasterGain> = {
  name: 'voicing-master-gain',
  kind: 'writes-working-register',
  run: (context) =>
    withWorkingRegisterRestored<VoicingMasterGain>(context, async (original) => {
      const gainSet = withRawValue(original, 'Master Gain', TEST_MASTER_GAIN);
      const findings = await writeWorkingRegister(context, gainSet);
      const afterGain = await readWorkingRegister(context);
      if (!afterGain.ok) {
        return {
          verdict: 'inconclusive',
          summary: 'Master Gain was written, but the Working Register could not be read back.',
          findings: [...findings, afterGain.finding],
        };
      }
      const masterGainBefore = rawValue(afterGain.program, 'Master Gain');
      if (masterGainBefore !== TEST_MASTER_GAIN) {
        return {
          verdict: 'inconclusive',
          summary: `Master Gain did not take the value written (${TEST_MASTER_GAIN}), so a reset could not be seen.`,
          findings: [...findings, `Master Gain read back as ${masterGainBefore} after writing ${TEST_MASTER_GAIN}.`],
        };
      }

      const voicingBefore = rawValue(gainSet, 'Voicing');
      const targetVoicing = voicingBefore === CLEAN_TUBE ? DISTORTION_TUBE : CLEAN_TUBE;
      // The only Working Register write is a whole Program, so this one still carries the non-zero Master Gain.
      findings.push(
        ...(await writeWorkingRegister(context, withRawValue(gainSet, 'Voicing', targetVoicing))),
        `Changed Voicing from ${voicingBefore} to ${targetVoicing} with a full Program that still carries Master Gain ${TEST_MASTER_GAIN}.`,
      );
      const afterVoicing = await readWorkingRegister(context);
      if (!afterVoicing.ok) {
        return {
          verdict: 'inconclusive',
          summary: 'Voicing was written, but the Working Register could not be read back.',
          findings: [...findings, afterVoicing.finding],
        };
      }
      const voicingAfter = rawValue(afterVoicing.program, 'Voicing');
      const masterGainAfter = rawValue(afterVoicing.program, 'Master Gain');
      findings.push(
        `Voicing before: ${voicingBefore}; after: ${voicingAfter}.`,
        `Master Gain before the Voicing change: ${masterGainBefore}; after: ${masterGainAfter}.`,
      );
      if (voicingAfter !== targetVoicing) {
        return {
          verdict: 'inconclusive',
          summary: `Voicing did not change (read back ${voicingAfter}, wrote ${targetVoicing}), so a reset could not be seen.`,
          findings,
        };
      }

      const data = { voicingBefore, voicingAfter, masterGainBefore, masterGainAfter };
      if (masterGainAfter === 0) {
        return {
          verdict: 'confirmed',
          summary: 'Changing Voicing through SysEx reset Master Gain to 0, as the front panel does.',
          findings,
          data: { reset: true, ...data },
        };
      }
      if (masterGainAfter === masterGainBefore) {
        return {
          verdict: 'refuted',
          summary: 'Changing Voicing through SysEx did not reset Master Gain: it kept the value sent in the same Program.',
          findings: [
            ...findings,
            'The new Voicing and the Master Gain came in one Program, so a reset that the unit applies before Master Gain would be hidden. This is what the editor sees when it sends whole Programs.',
          ],
          data: { reset: false, ...data },
        };
      }
      return {
        verdict: 'inconclusive',
        summary: `Master Gain went from ${masterGainBefore} to ${masterGainAfter} with the Voicing change: neither kept nor reset to 0.`,
        findings,
      };
    }),
};
