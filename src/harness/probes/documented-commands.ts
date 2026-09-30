import { checksum, hexBytes, isSysEx } from '../../core/sysex.js';
import type { Probe } from '../probe-runner.js';

/**
 * Sends the manual's documented Get Parameters (07) and Set Parameters (06) messages,
 * in the manual's layout:  F0 <ID> <channel> <device> <command> … <checksum> F7
 *
 * The manual is ambiguous, so each message is tried with both manufacturer IDs it
 * uses (0D and 00) and with device numbers 00 and 01 (the manual never names the
 * MP-1's). Both address only the Working Register (7F), so no Memory is written.
 */

const WORKING_REGISTER = 0x7f;
const MANUFACTURER_IDS = [0x0d, 0x00];
const DEVICES = [0x00, 0x01];

const MESSAGES = [
  // Eleven parameters from parameter 00. The manual's Get layout reads like a reply,
  // so the request mirrors Set Parameters: count, then base parameter number.
  { name: 'Get Parameters', command: 0x07, body: [WORKING_REGISTER, 0x0b, 0x00] },
  // One parameter, 02 (Master Gain in the manual's map), set to 0: the safest audible change.
  { name: 'Set Parameters', command: 0x06, body: [WORKING_REGISTER, 0x01, 0x02, 0x00] },
] as const;

export interface DocumentedCommandVariant {
  message: (typeof MESSAGES)[number]['name'];
  manufacturerId: number;
  device: number;
  sent: string;
  /** Raw reply bytes as hex, when one arrived. */
  reply?: string;
  /** The reply read in the manual's layout, when it fits. */
  decoded?: string;
}

export const documentedCommandsProbe: Probe<DocumentedCommandVariant[]> = {
  name: 'documented-commands',
  kind: 'non-destructive',
  async run({ wireChannel, timeoutMs, request }) {
    const variants: DocumentedCommandVariant[] = [];
    for (const { name, command, body } of MESSAGES) {
      for (const manufacturerId of MANUFACTURER_IDS) {
        for (const device of DEVICES) {
          const data = [manufacturerId, wireChannel, device, command, ...body];
          const bytes = Uint8Array.from([0xf0, ...data, checksum(data), 0xf7]);
          const reply = await request(bytes, isSysEx);
          variants.push({
            message: name,
            manufacturerId,
            device,
            sent: hexBytes(bytes),
            ...(reply && { reply: hexBytes(reply.bytes), decoded: decodeManualLayout(reply.bytes) }),
          });
        }
      }
    }

    const answered = variants.filter((variant) => variant.reply !== undefined);
    const findings = [
      'Set Parameters sets Master Gain in the Working Register to 0; recall the program to restore it.',
      ...variants.map(describe),
    ];
    if (answered.length === 0) {
      return {
        verdict: 'inconclusive',
        summary: `No reply to any documented Get or Set Parameters variant within ${timeoutMs} ms each.`,
        findings,
        data: variants,
      };
    }
    return {
      verdict: 'confirmed',
      summary: `The unit replied to ${answered.length} of ${variants.length} documented-command variants.`,
      findings,
      data: variants,
    };
  },
};

function describe(variant: DocumentedCommandVariant): string {
  const label = `${variant.message}, ID ${hexBytes([variant.manufacturerId])}, device ${hexBytes([variant.device])}`;
  const outcome = variant.reply ? `reply ${variant.reply} (${variant.decoded})` : 'no reply';
  return `${label}: sent ${variant.sent}; ${outcome}`;
}

/**
 * Reads a reply as  F0 <ID> <channel> <device> <command or 00 response ID> [<response type>] … <checksum> F7.
 * The manual's replies start with response ID 00 followed by the command they answer.
 */
function decodeManualLayout(bytes: Uint8Array): string {
  const all = [...bytes];
  if (all.length < 7 || all[all.length - 1] !== 0xf7) return 'does not fit the manual layout';
  const [id, channel, device, first, ...rest] = all.slice(1, -2);
  const received = all[all.length - 2]!;
  const expected = checksum(all.slice(1, -2));
  const kind = first === 0x00 && rest.length > 0 ? `response to ${hexBytes(rest.splice(0, 1))}` : `command ${hexBytes([first!])}`;
  const data = rest.length > 0 ? `data ${hexBytes(rest)}` : 'no data';
  const check = received === expected ? 'checksum OK' : `checksum mismatch: received ${hexBytes([received])}, computed ${hexBytes([expected])}`;
  return `ID ${hexBytes([id!])}, channel ${channel! + 1}, device ${hexBytes([device!])}, ${kind}, ${data}, ${check}`;
}
