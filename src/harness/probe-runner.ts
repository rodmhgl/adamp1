import { MEMORY_COUNT, memoryImageDifferences, memoryImageSyx, type MemoryImage } from '../core/memory-image.js';
import type { MidiMessage, MidiPort } from '../core/midi-port.js';
import type { Program } from '../core/program.js';
import { hex, hexBytes, isAdaSysEx } from '../core/sysex.js';
import { addressedProgramWrite } from '../core/working-register.js';
import { describeFailedRead, requestMemoryImage, type MemoryImageRead } from './memory-image-transfer.js';
import type { Operator } from './operator.js';

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
  /** Who to ask. Without one, a probe that asks anything fails. */
  operator?: Operator;
  /** Aborting it stops the probe at its next step; the runner then restores the backup where needed. */
  signal?: AbortSignal;
  /** The session's latest verified backup, if it has one. Probes that write Memories are refused without one. */
  backup?(): VerifiedBackup | undefined;
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

/** A backup saved to disk, with the Memory Image it holds. */
export interface VerifiedBackup extends SavedBackup {
  image: MemoryImage;
}

export const PROTECT_OFF_INSTRUCTION =
  'Set Protect OFF so the unit accepts the Memory Image: on the front panel, press Store, then Bank+8.';

export const PROTECT_ON_INSTRUCTION =
  'Set Protect ON so the unit should refuse the Memory Image: on the front panel, press Store, then Bank+8. ' +
  'The same keys turn Protect OFF again, so check the display shows Protect ON.';

export interface MemoryImageLoadOptions {
  /** Asks for Protect ON instead of OFF, for a load the unit should refuse. The restore afterwards asks for Protect OFF. */
  protectOn?: boolean;
}

/** How a message is sent: in chunks of `chunkBytes`, `delayMs` apart. A chunk as long as the message sends it whole. */
export interface Pacing {
  chunkBytes: number;
  delayMs: number;
}

/** Loads one of the Memory Images a series was confirmed for, sent as `pacing` says (default: whole). */
export type MemoryImageLoader = (image: MemoryImage, pacing?: Pacing) => Promise<MemoryWriteAnswer>;

/** What came back from a write to Memories. */
export interface MemoryWriteAnswer {
  /** The first ADA SysEx the unit sent within the reply timeout, if any. */
  reply?: MidiMessage;
  /** The reply as evidence, if any. */
  findings: string[];
}

export interface ProbeContext {
  /** 0-based channel, as on the wire. */
  wireChannel: number;
  timeoutMs: number;
  dumpTimeoutMs: number;
  operator: Operator;
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
  /**
   * Resolves with every received message that `accept` matches while `during` runs,
   * such as the maintainer's front-panel change. Sends nothing.
   */
  listenWhile(accept: (bytes: Uint8Array) => boolean, during: () => Promise<void>): Promise<MidiMessage[]>;
  /** Requests the Memory Image and checks the reply, waiting up to the dump timeout. */
  readMemoryImage(): Promise<MemoryImageRead>;
  /** The session's latest verified backup. A probe that writes Memories always has one. */
  backup(): VerifiedBackup | undefined;
  /** Saves a Memory Image the probe has verified to disk as the session's backup. */
  saveBackup(received: ReceivedMemoryImage): SavedBackup;
  /**
   * One of the two ways to write Memories. Asks the maintainer to confirm, showing how many
   * Memories change against the backup, then to set Protect OFF (or ON, with `protectOn`),
   * then sends `image` as a Memory Image load (command 0B) and waits the reply timeout
   * for any answer. Throws `MemoryWriteRefused`, having sent nothing, when the session
   * has no verified backup or the maintainer declines.
   */
  loadMemoryImage(image: MemoryImage, options?: MemoryImageLoadOptions): Promise<MemoryWriteAnswer>;
  /**
   * `loadMemoryImage` for a series of loads, such as timing them: asks the maintainer once
   * to confirm up to `count` loads, showing the most Memories any of `images` changes against
   * the backup, then to set Protect OFF. Resolves with a loader for those images only, which
   * throws once `count` loads are spent. Refuses as `loadMemoryImage` does. See ADR 0003.
   */
  beginMemoryImageLoads(images: readonly MemoryImage[], count: number): Promise<MemoryImageLoader>;
  /**
   * The other way to write Memories, for finding out whether one Memory can be written
   * directly. Asks the maintainer to confirm, then to set Protect OFF, then sends `program`
   * with command 09 addressed to `address` instead of the Working Register (7F), and waits
   * the reply timeout for any answer. Refuses as `loadMemoryImage` does.
   */
  writeProgramToAddress(address: number, program: Program): Promise<MemoryWriteAnswer>;
}

/** A write to Memories that was never sent. */
export class MemoryWriteRefused extends Error {
  constructor(
    summary: string,
    readonly findings: string[] = [],
  ) {
    super(summary);
  }
}

interface MemoryWrite {
  /** What the maintainer confirms, given the backup that will be restored. */
  question(saved: VerifiedBackup): string;
  label: string;
  protectOn?: boolean;
}

class ProbeStopped extends Error {
  constructor() {
    super('Stopped by the maintainer.');
  }
}

const NO_OPERATOR: Operator = {
  confirm: () => Promise.reject(new Error('This run has no operator to ask.')),
  instruct: () => Promise.reject(new Error('This run has no operator to ask.')),
  ask: () => Promise.reject(new Error('This run has no operator to ask.')),
  warn() {},
};

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

/**
 * Runs one probe, recording its traffic. Enforces the write-safety invariant: a probe
 * that writes Memories is refused without a verified backup, every write is confirmed,
 * and whenever the unit may no longer hold the backup when the probe ends — however it
 * ends — the backup is loaded back and checked with a dump.
 */
export async function runProbe<T>(probe: Probe<T>, settings: SessionSettings): Promise<ProbeReport<T>> {
  const traffic: TrafficEntry[] = [];
  const stopRecording = settings.port.onMessage(({ bytes, timestamp }) =>
    traffic.push({ direction: 'received', bytes: [...bytes], timestamp }),
  );
  const wireChannel = settings.channel - 1;
  const dumpTimeoutMs = settings.dumpTimeoutMs ?? DEFAULT_DUMP_TIMEOUT_MS;
  const operator = settings.operator ?? NO_OPERATOR;
  const backup = () => settings.backup?.();
  /** False from the moment a Memory write is sent until a dump shows the unit holds the backup again. */
  let unitHoldsBackup = true;
  /** Set once the maintainer was asked for Protect ON, so the restore asks for Protect OFF first. */
  let protectMayBeOn = false;
  /** The latest Memory Image load sent, so a dump that reads it back shows its pacing works. */
  let lastLoad: { image: MemoryImage; pacing?: Pacing } | undefined;
  /** How the latest load that read back as loaded was sent; the restore is sent the same way. */
  let restorePacing: Pacing | undefined;

  /**
   * Sends `request`, in chunks when `pacing` says so, and resolves with the first received
   * message `accept` matches, or `undefined` when none arrives within `timeoutMs` of the
   * last chunk. A stop while chunks are still going out waits for the last one, so the
   * unit never sees a message cut off part-way.
   */
  async function exchange(
    request: Uint8Array,
    accept: (bytes: Uint8Array) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
    pacing?: Pacing,
  ): Promise<MidiMessage | undefined> {
    if (signal?.aborted) throw new ProbeStopped();
    let reply: MidiMessage | undefined;
    let onReply = () => {};
    const stopListening = settings.port.onMessage((message) => {
      if (reply || sameBytes(message.bytes, request) || !accept(message.bytes)) return;
      reply = message;
      onReply();
    });
    try {
      await send(request, pacing);
      return await new Promise((resolve, reject) => {
        if (reply) return resolve(reply);
        if (signal?.aborted) return reject(new ProbeStopped());
        const timer = setTimeout(() => finish(undefined), timeoutMs);
        const onAbort = () => {
          cleanUp();
          reject(new ProbeStopped());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        onReply = () => finish(reply);
        function cleanUp() {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        }
        function finish(message: MidiMessage | undefined) {
          cleanUp();
          resolve(message);
        }
      });
    } finally {
      stopListening();
    }
  }

  /** Sends `message` whole and synchronously, or in chunks with `pacing`. */
  async function send(message: Uint8Array, pacing?: Pacing): Promise<void> {
    if (pacing && !(Number.isInteger(pacing.chunkBytes) && pacing.chunkBytes > 0)) {
      throw new Error(`Chunks must be a positive whole number of bytes, not ${pacing.chunkBytes}.`);
    }
    const chunkBytes = pacing?.chunkBytes ?? message.length;
    for (let start = 0; start < message.length; start += chunkBytes) {
      if (start > 0 && pacing!.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, pacing!.delayMs));
      const chunk = message.subarray(start, start + chunkBytes);
      traffic.push({ direction: 'sent', bytes: [...chunk], timestamp: performance.now() });
      settings.port.send(chunk);
    }
  }

  async function readMemoryImage(signal?: AbortSignal): Promise<MemoryImageRead> {
    const read = await requestMemoryImage((request, accept, timeoutMs) => exchange(request, accept, timeoutMs, signal), wireChannel, dumpTimeoutMs);
    const saved = backup();
    if (read.ok && saved && memoryImageDifferences(saved.image, read.image).length === 0) unitHoldsBackup = true;
    if (read.ok && lastLoad && memoryImageDifferences(lastLoad.image, read.image).length === 0) restorePacing = lastLoad.pacing;
    return read;
  }

  const context: ProbeContext = {
    wireChannel,
    timeoutMs: settings.timeoutMs,
    dumpTimeoutMs,
    operator,
    request: (request, accept, timeoutMs = settings.timeoutMs) => exchange(request, accept, timeoutMs, settings.signal),
    async listenWhile(accept, during) {
      const received: MidiMessage[] = [];
      const stopListening = settings.port.onMessage((message) => {
        if (accept(message.bytes)) received.push(message);
      });
      try {
        await during();
      } finally {
        stopListening();
      }
      if (settings.signal?.aborted) throw new ProbeStopped();
      return received;
    },
    readMemoryImage: () => readMemoryImage(settings.signal),
    backup,
    saveBackup: (received) => {
      if (!settings.saveBackup) throw new Error('This run has no session folder to save a backup to.');
      const saved = settings.saveBackup(received);
      // A backup is a dump just read from the unit, so the unit holds it.
      unitHoldsBackup = true;
      return saved;
    },
    async loadMemoryImage(image, { protectOn = false } = {}) {
      const load = await beginMemoryImageLoads([image], 1, protectOn);
      return load(image);
    },
    beginMemoryImageLoads: (images, count) => beginMemoryImageLoads(images, count),
    async writeProgramToAddress(address, program) {
      const label = `the write to address ${hex(address)}`;
      await confirmMemoryWrites({
        question: (saved) =>
          `Send a Program with command 09 to address ${hex(address)}? It may overwrite one Memory. ` +
          `The backup to restore from is ${saved.syxFile}.`,
        label,
      });
      return sendMemoryWrite(addressedProgramWrite(wireChannel, address, program), label);
    },
  };

  async function beginMemoryImageLoads(images: readonly MemoryImage[], count: number, protectOn = false): Promise<MemoryImageLoader> {
    if (images.length === 0) throw new Error('A series of Memory Image loads needs at least one Memory Image.');
    const label = count === 1 ? 'the Memory Image load' : 'the Memory Image loads';
    await confirmMemoryWrites({
      question(saved) {
        const changes = Math.max(...images.map((image) => memoryImageDifferences(saved.image, image).length));
        const loads = count === 1 ? `Load a Memory Image into the unit? It changes` : `Load Memory Images into the unit up to ${count} times? Each load changes up to`;
        return `${loads} ${changes} of ${MEMORY_COUNT} Memories. The backup to restore from is ${saved.syxFile}.`;
      },
      label,
      protectOn,
    });
    let loadsLeft = count;
    return (image, pacing) => {
      if (loadsLeft === 0) throw new Error(`Only ${count} Memory Image loads were confirmed.`);
      if (!images.some((confirmed) => memoryImageDifferences(confirmed, image).length === 0)) {
        throw new Error('Only the Memory Images confirmed for this series can be loaded.');
      }
      loadsLeft--;
      lastLoad = { image, ...(pacing && { pacing }) };
      return sendMemoryWrite(memoryImageSyx(wireChannel, image), label, pacing);
    };
  }

  /**
   * Refuses without a backup; otherwise asks the maintainer to confirm, then for Protect OFF
   * (or ON). `label` names the write in evidence.
   */
  async function confirmMemoryWrites({ question, label, protectOn = false }: MemoryWrite): Promise<void> {
    const saved = backup();
    if (!saved) throw noBackup();
    const confirmed = await operator.confirm(question(saved));
    if (settings.signal?.aborted) throw new ProbeStopped();
    if (!confirmed) throw new MemoryWriteRefused(`The maintainer declined ${label}, so nothing was written.`);
    if (protectOn) protectMayBeOn = true;
    await operator.instruct(protectOn ? PROTECT_ON_INSTRUCTION : PROTECT_OFF_INSTRUCTION);
  }

  /** Sends a confirmed write to Memories and waits the reply timeout for any answer. */
  async function sendMemoryWrite(message: Uint8Array, label: string, pacing?: Pacing): Promise<MemoryWriteAnswer> {
    // Checked here so a stop during the prompt sends nothing. From here on `exchange` sends: a stop
    // while paced chunks are going out takes effect after the last one.
    if (settings.signal?.aborted) throw new ProbeStopped();
    unitHoldsBackup = false;
    const reply = await exchange(message, isAdaSysEx, settings.timeoutMs, settings.signal, pacing);
    return reply ? { reply, findings: [`The unit answered ${label} with ${hexBytes(reply.bytes)}.`] } : { findings: [] };
  }

  /**
   * Loads the backup and checks it with a dump, first asking for Protect OFF when the probe asked
   * for Protect ON. It is sent as the latest load that read back correctly was (whole if none
   * did), so a probe that found whole loads unreliable is restored in chunks. Not stoppable: it is what a stop falls back on, so it sends the
   * backup even when the maintainer can no longer be asked.
   */
  async function restoreBackup(saved: VerifiedBackup): Promise<string[]> {
    const findings: string[] = [];
    const retry = `${protectMayBeOn ? 'set Protect OFF and ' : ''}restore it with --restore <session folder>/${saved.syxFile}`;
    if (protectMayBeOn) {
      try {
        await operator.instruct(PROTECT_OFF_INSTRUCTION);
      } catch (error) {
        findings.push(`Could not ask for Protect OFF before restoring the backup (${String(error)}); sent it anyway.`);
      }
    }
    return [...findings, ...(await sendBackup(saved, retry))];
  }

  async function sendBackup(saved: VerifiedBackup, retry: string): Promise<string[]> {
    try {
      await exchange(memoryImageSyx(wireChannel, saved.image), isAdaSysEx, settings.timeoutMs, undefined, restorePacing);
      const read = await readMemoryImage();
      if (!read.ok) return [`WARNING: the restore of the backup could not be checked (${describeFailedRead(read)}); ${retry}.`];
      const differences = memoryImageDifferences(saved.image, read.image).length;
      if (differences === 0) return [`Restored the backup ${saved.syxFile}: the dump read back matches it.`];
      return [`WARNING: the restore of the backup did not read back as the backup: ${differences} Memories differ; ${retry}.`];
    } catch (error) {
      return [`WARNING: the restore of the backup failed (${String(error)}); ${retry}.`];
    }
  }

  try {
    if (probe.kind === 'writes-memories' && !backup()) {
      const refused = noBackup();
      return { probe: probe.name, verdict: 'inconclusive', summary: refused.message, findings: refused.findings, traffic };
    }

    let outcome: ProbeOutcome<T>;
    try {
      outcome = await probe.run(context);
    } catch (error) {
      outcome = failedOutcome(error, settings.signal);
    }
    const saved = backup();
    if (!unitHoldsBackup && saved) outcome = { ...outcome, findings: [...outcome.findings, ...(await restoreBackup(saved))] };
    return { probe: probe.name, ...outcome, traffic };
  } finally {
    stopRecording();
  }
}

function noBackup(): MemoryWriteRefused {
  return new MemoryWriteRefused('Refused to write Memories: this session has no verified backup Memory Image, so nothing was sent.', [
    'Run memory-image-dump first in the same session; a probe that writes Memories needs its backup.',
  ]);
}

function failedOutcome(error: unknown, signal: AbortSignal | undefined): ProbeOutcome<never> {
  // Checked first: stopping can also surface as an aborted operator prompt.
  if (signal?.aborted || error instanceof ProbeStopped) {
    return { verdict: 'inconclusive', summary: 'Stopped by the maintainer before reaching a verdict.', findings: [] };
  }
  if (error instanceof MemoryWriteRefused) {
    return { verdict: 'inconclusive', summary: error.message, findings: error.findings };
  }
  return { verdict: 'inconclusive', summary: 'The probe failed before reaching a verdict.', findings: [String(error)] };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
