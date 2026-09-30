import { describeProgram, programDifferences, type Program } from '../../core/program.js';
import { hexBytes, isSysEx } from '../../core/sysex.js';
import { parseWorkingRegisterReply, workingRegisterRequest, workingRegisterWrite } from '../../core/working-register.js';
import type { ProbeContext, ProbeOutcome } from '../probe-runner.js';

/** Steps shared by the probes that write the Working Register. */

export type WorkingRegisterRead = { ok: true; program: Program } | { ok: false; finding: string };

/** Requests the Working Register. Anything but a valid Program on the session's channel is a failure. */
export async function readWorkingRegister({ wireChannel, timeoutMs, request }: ProbeContext): Promise<WorkingRegisterRead> {
  // Take any SysEx as the reply, so a reply in an unexpected format is reported instead of timing out.
  const reply = await request(workingRegisterRequest(wireChannel), isSysEx);
  if (!reply) return { ok: false, finding: `No reply to the Working Register request within ${timeoutMs} ms.` };
  const parsed = parseWorkingRegisterReply(reply.bytes);
  if (!parsed.ok) return { ok: false, finding: `Reply ${hexBytes(reply.bytes)}: ${parsed.detail}.` };
  if (parsed.channel !== wireChannel) {
    return {
      ok: false,
      finding: `Reply ${hexBytes(reply.bytes)}: on channel ${parsed.channel + 1}, requested on channel ${wireChannel + 1}.`,
    };
  }
  return { ok: true, program: parsed.program };
}

/**
 * Sets the Working Register to `program`. No reply is expected, so this waits the full
 * timeout, which also gives the unit time to apply the Program before the next read.
 * Returns a finding when the unit does answer.
 */
export async function writeWorkingRegister(
  { wireChannel, request }: ProbeContext,
  program: Program,
): Promise<string[]> {
  const reply = await request(workingRegisterWrite(wireChannel, program), isSysEx);
  return reply ? [`The unit answered the write of ${describeProgram(program)} with ${hexBytes(reply.bytes)}.`] : [];
}

/**
 * Reads the Working Register, runs `experiment`, then writes the original Program back
 * and checks it. Nothing is written when the first read fails, since the unit could not
 * then be restored.
 */
export async function withWorkingRegisterRestored<T>(
  context: ProbeContext,
  experiment: (original: Program) => Promise<ProbeOutcome<T>>,
): Promise<ProbeOutcome<T>> {
  const original = await readWorkingRegister(context);
  if (!original.ok) {
    return {
      verdict: 'inconclusive',
      summary: 'The Working Register could not be read first, so nothing was written.',
      findings: [original.finding],
    };
  }

  let outcome: ProbeOutcome<T>;
  try {
    outcome = await experiment(original.program);
  } catch (error) {
    // Report the experiment's error, not a restore failure that follows it.
    await restore(context, original.program).catch(() => undefined);
    throw error;
  }
  return {
    ...outcome,
    findings: [
      `Working Register at the start: ${describeProgram(original.program)}.`,
      ...outcome.findings,
      ...(await restore(context, original.program)),
    ],
  };
}

async function restore(context: ProbeContext, original: Program): Promise<string[]> {
  const findings = await writeWorkingRegister(context, original);
  const check = await readWorkingRegister(context);
  if (check.ok && programDifferences(original, check.program).length === 0) {
    return [...findings, 'Restored the Working Register to the Program read at the start.'];
  }
  const reason = check.ok ? `read back ${describeProgram(check.program)}` : check.finding;
  return [
    ...findings,
    `WARNING: the restore of the Working Register did not read back as the original (${reason}); recall the Program on the unit to restore it.`,
  ];
}
