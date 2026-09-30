import { namedRawValues, type NamedRawValue } from '../../core/program.js';
import { hexBytes, isSysEx } from '../../core/sysex.js';
import { parseWorkingRegisterReply, workingRegisterRequest } from '../../core/working-register.js';
import type { Probe } from '../probe-runner.js';

/** Requests the Working Register and checks that a valid Program comes back. */
export const connectivityProbe: Probe<NamedRawValue[]> = {
  name: 'connectivity',
  kind: 'non-destructive',
  async run({ wireChannel, timeoutMs, request }) {
    // Take any SysEx as the reply, so a reply in an unexpected format refutes instead of timing out.
    const reply = await request(workingRegisterRequest(wireChannel), isSysEx);

    if (!reply) {
      return {
        verdict: 'inconclusive',
        summary: `No reply to the Working Register request within ${timeoutMs} ms.`,
        findings: [
          'Likely causes:',
          `- wrong MIDI channel: the harness used channel ${wireChannel + 1}; check the unit's MIDI channel setting`,
          '- the unit\'s MIDI channel is set to ALL or OFF',
          '- MIDI is locked by a front-panel edit in progress: finish or cancel it',
          '- the MIDI cable or interface drops SysEx',
          '- the unit\'s firmware is v1.x (Level 1), which has no SysEx: power up and read the number after "ADA"; the first digit must be 2',
        ],
      };
    }

    const replyEvidence = `Reply ${hexBytes(reply.bytes)}`;
    const parsed = parseWorkingRegisterReply(reply.bytes);
    if (!parsed.ok && parsed.error === 'checksum-mismatch') {
      // Either the transfer was corrupted or the checksum hypothesis is wrong: one reply can't tell which.
      return {
        verdict: 'inconclusive',
        summary: 'The unit replied, but the reply has a checksum mismatch, so its values cannot be trusted.',
        findings: [`${replyEvidence}: ${parsed.detail}.`],
      };
    }
    if (!parsed.ok) {
      return {
        verdict: 'refuted',
        summary: 'The unit replied, but not in the expected Working Register format.',
        findings: [`${replyEvidence}: ${parsed.detail}.`],
      };
    }
    if (parsed.channel !== wireChannel) {
      return {
        verdict: 'inconclusive',
        summary: 'The unit replied with a valid Program, but not on the channel it was asked on.',
        findings: [
          `${replyEvidence}: reply is on channel ${parsed.channel + 1}, requested on channel ${wireChannel + 1}.`,
        ],
      };
    }

    return {
      verdict: 'confirmed',
      summary: 'The unit answered a Working Register request with a valid Program.',
      findings: [`${replyEvidence}: checksum matches, addressed to 7F, ${parsed.program.raw.length} values.`],
      data: namedRawValues(parsed.program),
    };
  },
};
