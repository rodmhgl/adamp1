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
import { selectProbes, type Probe, type ProbeReport, type ProbeSelection } from './probe-runner.js';
import { connectivityProbe } from './probes/connectivity.js';
import { documentedCommandsProbe } from './probes/documented-commands.js';
import { runSession } from './session.js';

const PROBES: readonly Probe<unknown>[] = [connectivityProbe, documentedCommandsProbe];

/** Extra console output for probes whose data is worth showing beyond the findings. */
const PRINT_DATA: Record<string, (data: unknown) => void> = {
  connectivity(data) {
    console.log();
    console.log('Working Register (raw values):');
    for (const { name, raw } of data as NamedRawValue[]) console.log(`  ${name.padEnd(14)} ${raw}`);
  },
};

const USAGE = `Usage: npm run harness -- [--probe <name> | --all] [--in <input port> --out <output port> --channel <1-16>]
                           [--timeout <ms>] [--sessions-dir <folder>]
       npm run harness -- --list-ports

Without --in/--out/--channel the harness asks for the ports and channel, offering last session's as defaults.
Each session writes capture.log and report.json to a new folder under --sessions-dir (default harness-sessions).

Probes:
  connectivity          (default) request the Working Register and print its eleven raw values
  documented-commands   send the manual's Get/Set Parameters (07/06) variants to the Working Register
                        (sets Master Gain in the Working Register to 0)
  --all                 run every non-destructive probe`;

const DEFAULT_TIMEOUT_MS = 3000;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      in: { type: 'string' },
      out: { type: 'string' },
      channel: { type: 'string' },
      timeout: { type: 'string' },
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
          probes,
          sessionDir,
          onProbeFinished: printReport,
        });
        console.log();
        console.log(`Session saved to ${sessionDir} (capture.log, report.json)`);
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
