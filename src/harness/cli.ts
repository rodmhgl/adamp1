import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { NamedRawValue } from '../core/program.js';
import {
  chooseConnection,
  defaultSettingsFile,
  isMidiChannel,
  loadConnection,
  saveConnection,
  type Connection,
} from './connection.js';
import { createConsoleOperator } from './console-operator.js';
import { openMidi, type PortNames } from './jzz-port.js';
import {
  DEFAULT_DUMP_TIMEOUT_MS,
  selectProbes,
  type Probe,
  type ProbeReport,
  type ProbeSelection,
} from './probe-runner.js';
import { connectivityProbe } from './probes/connectivity.js';
import { documentedCommandsProbe } from './probes/documented-commands.js';
import { memoryImageDumpProbe } from './probes/memory-image-dump.js';
import { voicingMasterGainProbe } from './probes/voicing-master-gain.js';
import { workingRegisterWriteProbe } from './probes/working-register-write.js';
import { runSession } from './session.js';

const PROBES: readonly Probe<unknown>[] = [
  connectivityProbe,
  memoryImageDumpProbe,
  documentedCommandsProbe,
  workingRegisterWriteProbe,
  voicingMasterGainProbe,
];

/** Extra console output for probes whose data is worth showing beyond the findings. */
const PRINT_DATA: Record<string, (data: unknown) => void> = {
  connectivity(data) {
    console.log();
    console.log('Working Register (raw values):');
    for (const { name, raw } of data as NamedRawValue[]) console.log(`  ${name.padEnd(14)} ${raw}`);
  },
};

const DEFAULT_TIMEOUT_MS = 3000;

const USAGE = `Usage: npm run harness -- [--probe <name> | --all] [--in <input port> --out <output port> --channel <1-16>]
                           [--timeout <ms>] [--dump-timeout <ms>] [--sessions-dir <folder>]
       npm run harness -- --list-ports

Without --in/--out/--channel the harness asks for the ports and channel, offering last session's as defaults.
Each session writes capture.log and report.json to a new folder under --sessions-dir (default harness-sessions).
--timeout is the wait for each reply (default ${DEFAULT_TIMEOUT_MS} ms); --dump-timeout the wait for a Memory Image dump
(default ${DEFAULT_DUMP_TIMEOUT_MS} ms).

Probes:
  connectivity          (default) request the Working Register and print its eleven raw values
  memory-image-dump     request the Memory Image, check and time it, and save it as memory-image-<n>.syx
                        and a decoded memory-image-<n>.json: the session's backup
  documented-commands   send the manual's Get/Set Parameters (07/06) variants to the Working Register
                        (sets Master Gain in the Working Register to 0)
  working-register-write
                        write a known Program to the Working Register and read it back
                        (restores the Program that was sounding afterwards)
  voicing-master-gain   set Master Gain, change Voicing over SysEx, and check whether Master Gain was reset to 0
                        (restores the Program that was sounding afterwards)
  --all                 run every non-destructive probe (connectivity and memory-image-dump:
                        the others change the Working Register)`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      in: { type: 'string' },
      out: { type: 'string' },
      channel: { type: 'string' },
      timeout: { type: 'string' },
      'dump-timeout': { type: 'string' },
      probe: { type: 'string' },
      all: { type: 'boolean' },
      'sessions-dir': { type: 'string', default: 'harness-sessions' },
      'list-ports': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.all && values.probe !== undefined) {
    console.error(`Use --probe or --all, not both.\n\n${USAGE}`);
    return 2;
  }
  const selection: ProbeSelection = values.all ? { allNonDestructive: true } : (values.probe ?? 'connectivity');
  let probes: Probe<unknown>[];
  try {
    probes = selectProbes(PROBES, selection);
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const timeoutMs = values.timeout === undefined ? DEFAULT_TIMEOUT_MS : Number(values.timeout);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error(`--timeout must be a positive number of milliseconds, got "${values.timeout}".`);
    return 2;
  }
  const dumpTimeoutMs = values['dump-timeout'] === undefined ? DEFAULT_DUMP_TIMEOUT_MS : Number(values['dump-timeout']);
  if (!Number.isFinite(dumpTimeoutMs) || dumpTimeoutMs <= 0) {
    console.error(`--dump-timeout must be a positive number of milliseconds, got "${values['dump-timeout']}".`);
    return 2;
  }

  const midi = await openMidi();
  try {
    const ports = midi.ports();
    if (values['list-ports']) {
      printPorts(ports);
      return 0;
    }

    const operator = createConsoleOperator();
    try {
      const settingsFile = defaultSettingsFile();
      let connection: Connection;
      if (values.in === undefined && values.out === undefined && values.channel === undefined) {
        if (ports.inputs.length === 0 || ports.outputs.length === 0) {
          console.error('No MIDI input or output ports found. Is the USB-MIDI interface connected? (WSL2 sees none.)');
          return 1;
        }
        connection = await chooseConnection(operator, ports, await loadConnection(settingsFile));
      } else {
        const channel = Number(values.channel);
        if (!values.in || !values.out || !isMidiChannel(channel)) {
          console.error(`Give all of --in, --out and --channel (1-16), or none to choose interactively.\n\n${USAGE}`);
          return 2;
        }
        if (!ports.inputs.includes(values.in) || !ports.outputs.includes(values.out)) {
          console.error(`Unknown port. Use exact names from this list:`);
          printPorts(ports);
          return 2;
        }
        connection = { input: values.in, output: values.out, channel };
      }
      await saveConnection(settingsFile, connection);

      const port = await midi.open(connection.input, connection.output);
      try {
        const sessionDir = join(values['sessions-dir'], new Date().toISOString().replaceAll(':', '-'));
        const report = await runSession({
          port,
          operator,
          connection,
          timeoutMs,
          dumpTimeoutMs,
          probes,
          sessionDir,
          onProbeFinished: printReport,
        });
        console.log();
        console.log(`Session saved to ${sessionDir} (capture.log, report.json)`);
        if (report.backup) {
          console.log(`Memory Image backup: ${join(sessionDir, report.backup.syxFile)}`);
        }
        return report.probes.every(({ verdict }) => verdict === 'confirmed') ? 0 : 1;
      } finally {
        await port.close();
      }
    } finally {
      operator.close();
    }
  } finally {
    await midi.close();
  }
}

function printReport(report: ProbeReport<unknown>): void {
  console.log();
  console.log(`${report.probe}: ${report.verdict.toUpperCase()}`);
  console.log(report.summary);
  for (const finding of report.findings) console.log(finding);
  if (report.data !== undefined) PRINT_DATA[report.probe]?.(report.data);
}

function printPorts({ inputs, outputs }: PortNames): void {
  console.log('MIDI inputs:');
  for (const name of inputs) console.log(`  ${name}`);
  console.log('MIDI outputs:');
  for (const name of outputs) console.log(`  ${name}`);
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
