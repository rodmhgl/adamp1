import type { MemoryImage } from '../core/memory-image.js';
import type { MidiMessage, MidiPort } from '../core/midi-port.js';

export type Verdict = 'confirmed' | 'refuted' | 'inconclusive';

/**
 * What a probe does: leaves the unit as it was, changes the Working Register (the
 * sounding Program), writes Memories, or needs the maintainer at the front panel.
 * Only non-destructive probes run in "all non-destructive".
 */
export type ProbeKind = 'non-destructive' | 'writes-working-register' | 'writes-memories' | 'guided';

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
  /** How long to wait for a Memory Image dump. Defaults to `DEFAULT_DUMP_TIMEOUT_MS`. */
  dumpTimeoutMs?: number;
  /** Saves a verified Memory Image as the session's backup. Without it, saving a backup throws. */
  saveBackup?(received: ReceivedMemoryImage): SavedBackup;
}

/** The full dump reportedly takes several seconds, so its default wait is far longer than a reply's. */
export const DEFAULT_DUMP_TIMEOUT_MS = 15_000;

/** A Memory Image read from the unit, with its 0B frame exactly as received. */
export interface ReceivedMemoryImage {
  image: MemoryImage;
  syx: Uint8Array;
}

/** Where a backup was saved, relative to the session folder. */
export interface SavedBackup {
  syxFile: string;
  decodedFile: string;
}

export interface ProbeContext {
  /** 0-based channel, as on the wire. */
  wireChannel: number;
  timeoutMs: number;
  dumpTimeoutMs: number;
  /**
   * Sends `request` and resolves with the first received message that `accept`
   * matches, or `undefined` when none arrives within `timeoutMs` (default: the session's).
   * An exact echo of the request, which some interfaces loop back, is never a match.
   */
  request(
    request: Uint8Array,
    accept: (bytes: Uint8Array) => boolean,
    timeoutMs?: number,
  ): Promise<MidiMessage | undefined>;
  /** Saves a Memory Image the probe has verified to disk as the session's backup. */
  saveBackup(received: ReceivedMemoryImage): SavedBackup;
}

/** A single probe by name, or every probe that declares itself non-destructive, in registry order. */
export type ProbeSelection = string | { allNonDestructive: true };

export function selectProbes(registry: readonly Probe<unknown>[], selection: ProbeSelection): Probe<unknown>[] {
  if (typeof selection !== 'string') return registry.filter((probe) => probe.kind === 'non-destructive');
  const probe = registry.find(({ name }) => name === selection);
  if (!probe) {
    throw new Error(`Unknown probe "${selection}". Known probes: ${registry.map(({ name }) => name).join(', ')}.`);
  }
  return [probe];
}

export async function runProbe<T>(probe: Probe<T>, settings: SessionSettings): Promise<ProbeReport<T>> {
  const traffic: TrafficEntry[] = [];
  const stopRecording = settings.port.onMessage(({ bytes, timestamp }) =>
    traffic.push({ direction: 'received', bytes: [...bytes], timestamp }),
  );

  const context: ProbeContext = {
    wireChannel: settings.channel - 1,
    timeoutMs: settings.timeoutMs,
    dumpTimeoutMs: settings.dumpTimeoutMs ?? DEFAULT_DUMP_TIMEOUT_MS,
    request: (request, accept, timeoutMs = settings.timeoutMs) => {
      return new Promise((resolve) => {
        const timer = setTimeout(() => finish(undefined), timeoutMs);
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
    saveBackup: (received) => {
      if (!settings.saveBackup) throw new Error('This run has no session folder to save a backup to.');
      return settings.saveBackup(received);
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
