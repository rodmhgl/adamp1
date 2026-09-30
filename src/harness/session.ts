import type { MidiPort } from '../core/midi-port.js';
import { hexBytes } from '../core/sysex.js';
import type { Connection } from './connection.js';
import type { Operator } from './operator.js';
import {
  DEFAULT_DUMP_TIMEOUT_MS,
  runProbe,
  type Probe,
  type ProbeKind,
  type ProbeReport,
  type SavedBackup,
  type TrafficEntry,
  type Verdict,
} from './probe-runner.js';
import { SessionRecorder, wallClock } from './session-recorder.js';

export interface SessionOptions {
  port: MidiPort;
  operator: Operator;
  connection: Connection;
  /** How long each probe waits for each reply. */
  timeoutMs: number;
  /** How long to wait for a Memory Image dump. Defaults to `DEFAULT_DUMP_TIMEOUT_MS`. */
  dumpTimeoutMs?: number;
  probes: readonly Probe<unknown>[];
  /** Folder for this session's capture log and report. */
  sessionDir: string;
  /** Called as each probe finishes, before the next starts. */
  onProbeFinished?(report: ProbeReport<unknown>): void;
}

/** The machine-readable record of one session, written as `report.json`. */
export interface SessionReport {
  startedAt: string;
  /** Absent while the session is still running or if it was aborted. */
  finishedAt?: string;
  firmware: Firmware;
  connection: Connection;
  timeoutMs: number;
  dumpTimeoutMs: number;
  /** The latest verified Memory Image saved this session. Probes that write Memories need one. */
  backup?: SessionBackup;
  probes: SessionProbeReport[];
}

export interface SessionBackup extends SavedBackup {
  /** The probe that took it. */
  probe: string;
  savedAt: string;
}

export interface Firmware {
  /** Exactly what the maintainer typed. */
  entered: string;
  /** Normalised, e.g. "2.01", when the entry reads as a version. */
  version?: string;
  /** The software level: the first digit of the power-up number. */
  level?: number;
  /** Present whenever the unit isn't known to be v2.x. */
  warning?: string;
}

export interface SessionProbeReport {
  probe: string;
  kind: ProbeKind;
  verdict: Verdict;
  summary: string;
  findings: string[];
  data?: unknown;
  traffic: { direction: TrafficEntry['direction']; time: string; bytes: string }[];
}

const FIRMWARE_QUESTION =
  'At power-up the display shows "ADA" and then a three-digit number, e.g. 201 for v2.01. ' +
  'Enter the firmware version it shows';

/**
 * Runs one harness session: asks for the firmware version, then runs each probe
 * in order, recording all MIDI traffic to the capture log and each probe's verdict
 * and evidence to the report. The report is rewritten after every probe.
 */
export async function runSession(options: SessionOptions): Promise<SessionReport> {
  const { port, operator, connection, timeoutMs, probes, sessionDir } = options;
  const dumpTimeoutMs = options.dumpTimeoutMs ?? DEFAULT_DUMP_TIMEOUT_MS;
  const recorder = new SessionRecorder(sessionDir);
  const report: SessionReport = {
    startedAt: new Date().toISOString(),
    firmware: readFirmware(await operator.ask(FIRMWARE_QUESTION)),
    connection,
    timeoutMs,
    dumpTimeoutMs,
    probes: [],
  };
  if (report.firmware.warning) operator.warn(report.firmware.warning);
  recorder.writeReport(report);

  const stopCapturing = port.onMessage(({ bytes, timestamp }) => recorder.message('received', bytes, timestamp));
  const recordedPort: MidiPort = {
    send(bytes) {
      recorder.message('sent', bytes, performance.now());
      port.send(bytes);
    },
    onMessage: (listener) => port.onMessage(listener),
  };

  try {
    for (const probe of probes) {
      recorder.heading(`probe ${probe.name} (${probe.kind})`);
      const probeReport = await runProbe(probe, {
        port: recordedPort,
        channel: connection.channel,
        timeoutMs,
        dumpTimeoutMs,
        saveBackup(received) {
          const saved = recorder.saveMemoryImage(received);
          report.backup = { probe: probe.name, savedAt: new Date().toISOString(), ...saved };
          return saved;
        },
      });
      report.probes.push(toSessionProbeReport(probe.kind, probeReport));
      recorder.writeReport(report);
      options.onProbeFinished?.(probeReport);
    }
  } finally {
    stopCapturing();
  }

  report.finishedAt = new Date().toISOString();
  recorder.writeReport(report);
  return report;
}

/** Reads what the maintainer typed from the power-up display: "201", "2.01" and "v2.01" are all v2.01. */
function readFirmware(entered: string): Firmware {
  const match = /^v?\s*(\d)\.?(\d\d)$/i.exec(entered.trim());
  if (!match) {
    return {
      entered,
      warning: `"${entered}" doesn't read as a firmware version, so the unit counts as not v2.x. The harness targets v2.x (Level 2) only: results may not apply, and writing Memories may be unsafe.`,
    };
  }
  const level = Number(match[1]);
  const version = `${match[1]}.${match[2]}`;
  if (level === 2) return { entered, version, level };
  return {
    entered,
    version,
    level,
    warning:
      `Firmware ${version} is not v2.x. Level 1 firmware has no SysEx, so probes are expected to time out, ` +
      'results from any non-v2.x unit may not apply to the editor, and writing its Memories may be unsafe.',
  };
}

function toSessionProbeReport(kind: ProbeKind, report: ProbeReport<unknown>): SessionProbeReport {
  const { probe, verdict, summary, findings, data, traffic } = report;
  return {
    probe,
    kind,
    verdict,
    summary,
    findings,
    ...(data !== undefined && { data }),
    traffic: traffic.map(({ direction, bytes, timestamp }) => ({
      direction,
      time: wallClock(timestamp),
      bytes: hexBytes(bytes),
    })),
  };
}
