import { ADA_MANUFACTURER_ID, checksum, hexBytes, isSysEx, parseFrame, SYSEX_END, SYSEX_START } from '../../core/sysex.js';
import { workingRegisterRequest } from '../../core/working-register.js';
import type { Probe, ProbeContext } from '../probe-runner.js';

/** The Working Register request (08) with the channel byte left out: F0 0D 08 01 <checksum> F7. */
const NO_CHANNEL_BYTE_BODY = [ADA_MANUFACTURER_ID, 0x08, 0x01];
const NO_CHANNEL_BYTE = Uint8Array.from([SYSEX_START, ...NO_CHANNEL_BYTE_BODY, checksum(NO_CHANNEL_BYTE_BODY), SYSEX_END]);

/** The unit's MIDI channel setting: ALL (omni), OFF, or one channel. */
export type ChannelSetting = 'ALL' | 'OFF' | `channel ${number}`;

/** A Working Register request and how it is addressed, e.g. "on channel 2". */
interface AddressedRequest {
  addressed: string;
  bytes: Uint8Array;
}

export interface ChannelSettingAttempt {
  /** The unit's MIDI channel setting while this was sent. */
  setting: ChannelSetting;
  /** How the request was addressed, e.g. "on channel 2" or "with no channel byte". */
  addressed: string;
  sent: string;
  /** Raw reply bytes as hex, when one arrived. */
  reply?: string;
  /** The channel the reply carries (1–16), when it parses as an MP-1 frame. */
  replyChannel?: number;
}

/**
 * The maintainer sets the unit's MIDI channel to ALL, then OFF, then back to the
 * session's channel; for each setting the probe sends Working Register requests (08)
 * and records any reply. No Memory or Working Register is written.
 *
 * The hypothesis under test is the manual's (§4.0), checked on the session's channel
 * and the next one: in ALL the unit answers on both, in OFF on neither, and set to the
 * session's channel only on that one. In OFF the probe also sends the request with no
 * channel byte; that result is reported but not part of the hypothesis.
 */
export const channelModesProbe: Probe<ChannelSettingAttempt[]> = {
  name: 'channel-modes',
  kind: 'guided',
  async run(context) {
    const { wireChannel, operator } = context;
    const otherWireChannel = (wireChannel + 1) % 16;
    const own: AddressedRequest = { addressed: `on channel ${wireChannel + 1}`, bytes: workingRegisterRequest(wireChannel) };
    const other: AddressedRequest = {
      addressed: `on channel ${otherWireChannel + 1}`,
      bytes: workingRegisterRequest(otherWireChannel),
    };
    const noChannelByte: AddressedRequest = { addressed: 'with no channel byte', bytes: NO_CHANNEL_BYTE };
    const ownSetting: ChannelSetting = `channel ${wireChannel + 1}`;

    await operator.instruct(setChannelInstruction('ALL', 'ALL'));
    const allOwn = await send(context, 'ALL', own);
    const allOther = await send(context, 'ALL', other);
    await operator.instruct(setChannelInstruction('OFF', 'OFF'));
    const offOwn = await send(context, 'OFF', own);
    const offNoChannelByte = await send(context, 'OFF', noChannelByte);
    await operator.instruct(setChannelInstruction(`this session's channel ${wireChannel + 1}`, String(wireChannel + 1)));
    const settingOwn = await send(context, ownSetting, own);
    const settingOther = await send(context, ownSetting, other);

    const attempts = [allOwn, allOther, offOwn, offNoChannelByte, settingOwn, settingOther];
    const findings = attempts.map(describe);
    if (!settingOwn.reply) {
      return {
        verdict: 'inconclusive',
        summary: `The unit never answered on its own channel ${wireChannel + 1}, so its silence in the other settings says nothing.`,
        findings,
        data: attempts,
      };
    }

    const unexpected = [
      ...[allOwn, allOther].filter(({ reply }) => !reply).map(({ addressed }) => `ALL: did not answer ${addressed}.`),
      ...[offOwn, settingOther].filter(({ reply }) => reply).map(({ setting, addressed }) => `${setting}: answered ${addressed}.`),
    ];
    if (unexpected.length > 0) {
      return {
        verdict: 'refuted',
        summary: "The unit does not follow the manual's MIDI channel settings for SysEx.",
        findings: [...findings, ...unexpected],
        data: attempts,
      };
    }
    return {
      verdict: 'confirmed',
      summary:
        `Set to ALL the unit answered SysEx on channels ${wireChannel + 1} and ${otherWireChannel + 1}; set to OFF, not on ` +
        `channel ${wireChannel + 1}; set to ${ownSetting}, only on that channel.`,
      findings,
      data: attempts,
    };
  },
};

function setChannelInstruction(setting: string, display: string): string {
  return (
    `Set the unit's MIDI channel to ${setting}: press MIDI CHNL, use ^ V until the display reads ${display}, ` +
    'then press MIDI CHNL again to save and exit.'
  );
}

async function send(
  { request }: ProbeContext,
  setting: ChannelSetting,
  { addressed, bytes }: AddressedRequest,
): Promise<ChannelSettingAttempt> {
  // Take any SysEx as the reply, so a reply in an unexpected format is recorded instead of timing out.
  const reply = await request(bytes, isSysEx);
  const attempt: ChannelSettingAttempt = { setting, addressed, sent: hexBytes(bytes) };
  if (!reply) return attempt;
  const parsed = parseFrame(reply.bytes);
  return {
    ...attempt,
    reply: hexBytes(reply.bytes),
    ...('frame' in parsed && { replyChannel: parsed.frame.channel + 1 }),
  };
}

function describe({ setting, addressed, sent, reply, replyChannel }: ChannelSettingAttempt): string {
  if (!reply) return `${setting}, ${addressed}: no reply; sent ${sent}.`;
  const channel = replyChannel === undefined ? 'not an MP-1 frame' : `reply on channel ${replyChannel}`;
  return `${setting}, ${addressed}: reply ${reply} (${channel}); sent ${sent}.`;
}
