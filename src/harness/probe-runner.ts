import type { MidiMessage, MidiPort } from '../core/midi-port.js';

export type Verdict = 'confirmed' | 'refuted' | 'inconclusive';

/** What a probe does to the unit. Later tickets add Memory-writing and operator-guided probes. */
export type ProbeKind = 'non-destructive';

export interface Probe<T> {
  name: string;
  kind: ProbeKind;
  run(context: ProbeContext): Promise<ProbeOutcome<T>>;
}

export interface ProbeOutcome<T> {
  verdict: Verdict;
  summary: string;
  /** Evidence and explanations, one statement each. */
  findings: string[];
  data?: T;
}

export interface ProbeReport<T> extends ProbeOutcome<T> {
  probe: string;
  traffic: TrafficEntry[];
}

export interface TrafficEntry {
  direction: 'sent' | 'received';
  bytes: number[];
  timestamp: number;
}

export interface SessionSettings {
  port: MidiPort;
  /** MIDI channel as the unit shows it, 1–16. */
  channel: number;
  /** How long to wait for each reply. */
  timeoutMs: number;
}

export interface ProbeContext {
  /** 0-based channel, as on the wire. */
  wireChannel: number;
  timeoutMs: number;
  /**
   * Sends `request` and resolves with the first received message that `accept`
   * matches, or `undefined` when none arrives within the timeout.
   * An exact echo of the request, which some interfaces loop back, is never a match.
   */
  request(request: Uint8Array, accept: (bytes: Uint8Array) => boolean): Promise<MidiMessage | undefined>;
}

export async function runProbe<T>(probe: Probe<T>, settings: SessionSettings): Promise<ProbeReport<T>> {
  const traffic: TrafficEntry[] = [];
  const stopRecording = settings.port.onMessage(({ bytes, timestamp }) =>
    traffic.push({ direction: 'received', bytes: [...bytes], timestamp }),
  );

  const context: ProbeContext = {
    wireChannel: settings.channel - 1,
    timeoutMs: settings.timeoutMs,
    request: (request, accept) => {
      return new Promise((resolve) => {
        const timer = setTimeout(() => finish(undefined), settings.timeoutMs);
        const stopListening = settings.port.onMessage((message) => {
          if (!sameBytes(message.bytes, request) && accept(message.bytes)) finish(message);
        });
        function finish(message: MidiMessage | undefined) {
          clearTimeout(timer);
          stopListening();
          resolve(message);
        }
        traffic.push({ direction: 'sent', bytes: [...request], timestamp: performance.now() });
        settings.port.send(request);
      });
    },
  };

  try {
    const outcome = await probe.run(context);
    return { probe: probe.name, ...outcome, traffic };
  } catch (error) {
    return {
      probe: probe.name,
      verdict: 'inconclusive',
      summary: 'The probe failed before reaching a verdict.',
      findings: [String(error)],
      traffic,
    };
  } finally {
    stopRecording();
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
