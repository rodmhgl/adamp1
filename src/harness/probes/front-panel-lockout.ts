import type { MidiMessage } from '../../core/midi-port.js';
import { hexBytes, isSysEx } from '../../core/sysex.js';
import { workingRegisterRequest } from '../../core/working-register.js';
import type { Probe } from '../probe-runner.js';

export interface FrontPanelLockout {
  repliedDuringEdit: boolean;
  /** The control: a unit that doesn't reply after the edit either says nothing about the lockout. */
  repliedAfterEdit: boolean;
}

// Pressing EDIT starts the edit session and the lockout (§3.2). Changing nothing means pressing
// EDIT again ends it: a changed value would stay pending, and locked, until stored or another Memory is selected.
const START_EDIT = 'Start a front-panel edit: press EDIT so the display reads "Edit". Change nothing.';
const ABANDON_EDIT = 'Abandon the edit: press EDIT again so its LED turns off.';

/**
 * The manual (§3.2) says the MIDI interface is disabled from the start of a front-panel
 * edit session until it is stored or abandoned. The maintainer starts one; the probe sends a
 * Working Register request (08); the maintainer abandons the edit; the probe sends it again.
 * "Confirmed" means the unit was silent during the edit and answered after it.
 * Nothing is written to the unit.
 */
export const frontPanelLockoutProbe: Probe<FrontPanelLockout> = {
  name: 'front-panel-lockout',
  kind: 'guided',
  async run({ wireChannel, timeoutMs, operator, request }) {
    // Take any SysEx as the reply: whether the unit answers matters here, not what it says.
    const requestWorkingRegister = () => request(workingRegisterRequest(wireChannel), isSysEx);

    await operator.instruct(START_EDIT);
    const duringEdit = await requestWorkingRegister();
    await operator.instruct(ABANDON_EDIT);
    const afterEdit = await requestWorkingRegister();

    const data = { repliedDuringEdit: duringEdit !== undefined, repliedAfterEdit: afterEdit !== undefined };
    const findings = [describe('During the edit', duringEdit, timeoutMs), describe('After the edit', afterEdit, timeoutMs)];
    if (duringEdit) {
      return {
        verdict: 'refuted',
        summary: 'The unit replied during the front-panel edit: MIDI is not locked out.',
        findings,
        data,
      };
    }
    if (!afterEdit) {
      return {
        verdict: 'inconclusive',
        summary: 'The unit did not reply during the edit or after it, so its silence during the edit says nothing.',
        findings,
        data,
      };
    }
    return {
      verdict: 'confirmed',
      summary: 'The unit did not reply during the front-panel edit, and replied once it was abandoned: MIDI is locked out during an edit.',
      findings,
      data,
    };
  },
};

function describe(when: string, reply: MidiMessage | undefined, timeoutMs: number): string {
  return reply ? `${when}: reply ${hexBytes(reply.bytes)}.` : `${when}: no reply within ${timeoutMs} ms.`;
}
