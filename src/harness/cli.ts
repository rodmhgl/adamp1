import { parseArgs } from 'node:util';
import { openMidi } from './jzz-port.js';
import { runProbe, type ProbeReport, type SessionSettings } from './probe-runner.js';
import { connectivityProbe } from './probes/connectivity.js';
import { documentedCommandsProbe } from './probes/documented-commands.js';

/** Each runnable probe, with how to print its report. */
const PROBES = {
  connectivity: async (settings: SessionSettings) => {
    const report = await runProbe(connectivityProbe, settings);
    printReport(report);
    if (report.data) {
      console.log();
      console.log('Working Register (raw values):');
      for (const { name, raw } of report.data) console.log(`  ${name.padEnd(14)} ${raw}`);
    }
    return report;
  },
  'documented-commands': async (settings: SessionSettings) => {
    const report = await runProbe(documentedCommandsProbe, settings);
    printReport(report);
    return report;
  },
};

const USAGE = `Usage: npm run harness -- --in <input port> --out <output port> --channel <1-16> [--probe <name>] [--timeout <ms>]
       npm run harness -- --list-ports

Probes:
  connectivity          (default) request the Working Register and print its eleven raw values
  documented-commands   send the manual's Get/Set Parameters (07/06) variants to the Working Register
                        (sets Master Gain in the Working Register to 0)`;

const DEFAULT_TIMEOUT_MS = 3000;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      in: { type: 'string' },
      out: { type: 'string' },
      channel: { type: 'string' },
      timeout: { type: 'string' },
      probe: { type: 'string', default: 'connectivity' },
      'list-ports': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const midi = await openMidi();
  try {
    const ports = midi.ports();
    if (values['list-ports']) {
      printPorts(ports);
      return 0;
    }

    const channel = Number(values.channel);
    const timeoutMs = values.timeout === undefined ? DEFAULT_TIMEOUT_MS : Number(values.timeout);
    if (!values.in || !values.out || !Number.isInteger(channel) || channel < 1 || channel > 16) {
      console.error(USAGE);
      return 2;
    }
    const probeName = values.probe;
    if (!isProbeName(probeName)) {
      console.error(`Unknown probe "${probeName}".\n\n${USAGE}`);
      return 2;
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      console.error(`--timeout must be a positive number of milliseconds, got "${values.timeout}".`);
      return 2;
    }
    if (!ports.inputs.includes(values.in) || !ports.outputs.includes(values.out)) {
      console.error(`Unknown port. Use exact names from this list:`);
      printPorts(ports);
      return 2;
    }

    const port = await midi.open(values.in, values.out);
    try {
      const report = await PROBES[probeName]({ port, channel, timeoutMs });
      return report.verdict === 'confirmed' ? 0 : 1;
    } finally {
      await port.close();
    }
  } finally {
    await midi.close();
  }
}

function isProbeName(name: string): name is keyof typeof PROBES {
  return Object.hasOwn(PROBES, name);
}

function printReport(report: ProbeReport<unknown>): void {
  console.log(`${report.probe}: ${report.verdict.toUpperCase()}`);
  console.log(report.summary);
  for (const finding of report.findings) console.log(finding);
}

function printPorts({ inputs, outputs }: { inputs: string[]; outputs: string[] }): void {
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
