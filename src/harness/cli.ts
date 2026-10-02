import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseMemoryImageSyx } from '../core/memory-image.js';
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
import { channelModesProbe } from './probes/channel-modes.js';
import { connectivityProbe } from './probes/connectivity.js';
import { directMemoryWriteProbe } from './probes/direct-memory-write.js';
import { documentedCommandsProbe } from './probes/documented-commands.js';
import { frontPanelLockoutProbe } from './probes/front-panel-lockout.js';
import { loadPacingProbe, type LoadPacingOptions } from './probes/load-pacing.js';
import { memoryImageDumpProbe } from './probes/memory-image-dump.js';
import { memoryImageLoadProbe } from './probes/memory-image-load.js';
import { protectOnLoadProbe } from './probes/protect-on-load.js';
import { programChangeInProbe } from './probes/program-change-in.js';
import { programChangeOutProbe } from './probes/program-change-out.js';
import { restoreProbe } from './probes/restore.js';
import { voicingMasterGainProbe } from './probes/voicing-master-gain.js';
import { workingRegisterWriteProbe } from './probes/working-register-write.js';
import { runSession } from './session.js';

const probesFor = (pacing: LoadPacingOptions): readonly Probe<unknown>[] => [
  connectivityProbe,
  memoryImageDumpProbe,
  documentedCommandsProbe,
  workingRegisterWriteProbe,
  voicingMasterGainProbe,
  memoryImageLoadProbe,
  protectOnLoadProbe,
  directMemoryWriteProbe,
  loadPacingProbe(pacing),
  channelModesProbe,
  frontPanelLockoutProbe,
  programChangeOutProbe,
  programChangeInProbe,
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
const DEFAULT_PACING_CHUNKS = 'whole,256,64';
const DEFAULT_PACING_DELAYS = '0,10,50';
const DEFAULT_PACING_REPEATS = '3';

const USAGE = `Usage: npm run harness -- [--probe <name> | --all] [--in <input port> --out <output port> --channel <1-16>]
                           [--timeout <ms>] [--dump-timeout <ms>] [--sessions-dir <folder>]
                           [--pacing-chunks <bytes,…>] [--pacing-delays <ms,…>] [--pacing-repeats <n>]
       npm run harness -- --restore <file.syx> [--in … --out … --channel …]
       npm run harness -- --list-ports

Without --in/--out/--channel the harness asks for the ports and channel, offering last session's as defaults.
Each session writes capture.log and report.json to a new folder under --sessions-dir (default harness-sessions).
--timeout is the wait for each reply (default ${DEFAULT_TIMEOUT_MS} ms); --dump-timeout the wait for a Memory Image dump
(default ${DEFAULT_DUMP_TIMEOUT_MS} ms).

Probes that write Memories, and --restore, first run memory-image-dump to take the session's backup, and are
refused if it fails. Each write asks for confirmation, showing how many Memories change. Ctrl-C stops the running
probe and loads the backup back where needed; press it again to quit at once.

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
  memory-image-load     load the backup with its Memories rotated by one, dump it back and compare
                        (writes Memories; loads the backup back afterwards)
  protect-on-load       guided: set Protect ON; the harness loads the rotated backup, dumps it back and records
                        whether the unit stayed silent, answered, or wrote some Memories anyway
                        (writes Memories if the unit ignores Protect; then asks for Protect OFF and loads the backup back)
  direct-memory-write   send a Program with command 09 addressed to Memory 2, as 0-based (01) then 1-based (02),
                        and dump after each to see which Memory changed, then read the Working Register
                        (may write Memories; restores the Program that was sounding, then loads the backup back)
  load-pacing           load Memory Images in chunks of each --pacing-chunks size (bytes, or "whole"; default
                        ${DEFAULT_PACING_CHUNKS}) with each --pacing-delays pause between chunks (ms; default ${DEFAULT_PACING_DELAYS}),
                        --pacing-repeats times each (default ${DEFAULT_PACING_REPEATS}), dumping after every load; reports each
                        setting's success rate and the fastest that never failed
                        (writes Memories; loads the backup back afterwards)
  channel-modes         guided: set the unit's MIDI channel to ALL, then OFF, then back to the session's channel;
                        each time the harness checks which channels the unit answers SysEx on
  front-panel-lockout   guided: start a front-panel edit; the harness checks whether the unit still answers,
                        then you abandon the edit
  program-change-out    guided: select a Memory on the front panel; the harness records any Program Change sent
  program-change-in     guided: the harness sends a Program Change and finds which Memory it loaded, from the display
                        and the Working Register (replaces the Working Register; asks first)
  --restore <file.syx>  load a saved Memory Image (e.g. a session's memory-image-<n>.syx) and check it with a dump
  --all                 run every non-destructive probe (connectivity and memory-image-dump:
                        the others change the Working Register or need you at the front panel)`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      in: { type: 'string' },
      out: { type: 'string' },
      channel: { type: 'string' },
      timeout: { type: 'string' },
      'dump-timeout': { type: 'string' },
      probe: { type: 'string' },
      restore: { type: 'string' },
      all: { type: 'boolean' },
      'pacing-chunks': { type: 'string', default: DEFAULT_PACING_CHUNKS },
      'pacing-delays': { type: 'string', default: DEFAULT_PACING_DELAYS },
      'pacing-repeats': { type: 'string', default: DEFAULT_PACING_REPEATS },
      'sessions-dir': { type: 'string', default: 'harness-sessions' },
      'list-ports': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if ([values.all, values.probe, values.restore].filter((value) => value !== undefined).length > 1) {
    console.error(`Use one of --probe, --all and --restore.\n\n${USAGE}`);
    return 2;
  }
  let probes: Probe<unknown>[];
  if (values.restore !== undefined) {
    let bytes: Buffer;
    try {
      bytes = await readFile(values.restore);
    } catch (error) {
      console.error(`Cannot read ${values.restore}: ${(error as Error).message}`);
      return 2;
    }
    const parsed = parseMemoryImageSyx(bytes);
    if (!parsed.ok) {
      console.error(`${values.restore} is not a valid Memory Image (${parsed.error}): ${parsed.detail}.`);
      return 2;
    }
    probes = [restoreProbe(values.restore, parsed.image)];
  } else {
    const pacing = readPacingOptions(values['pacing-chunks'], values['pacing-delays'], values['pacing-repeats']);
    if (typeof pacing === 'string') {
      console.error(pacing);
      return 2;
    }
    const selection: ProbeSelection = values.all ? { allNonDestructive: true } : (values.probe ?? 'connectivity');
    try {
      probes = selectProbes(probesFor(pacing), selection);
    } catch (error) {
      console.error(`${(error as Error).message}\n\n${USAGE}`);
      return 2;
    }
  }
  // A write needs a backup taken in the same session.
  if (probes.some(({ kind }) => kind === 'writes-memories')) probes = [memoryImageDumpProbe, ...probes];
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

    const stop = new AbortController();
    const interrupt = () => {
      if (stop.signal.aborted) process.exit(130);
      console.warn('\nStopping: the unit is put back to its backup where needed. Press Ctrl-C again to quit at once.');
      stop.abort();
    };
    process.on('SIGINT', interrupt);
    const operator = createConsoleOperator({ signal: stop.signal, onInterrupt: interrupt });
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
          signal: stop.signal,
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

/** The load-pacing settings, or what's wrong with them. */
function readPacingOptions(chunks: string, delays: string, repeats: string): LoadPacingOptions | string {
  const list = (value: string) => value.split(',').map((entry) => entry.trim());
  const chunkSizes = list(chunks).map((size) => (size === 'whole' ? 'whole' : size === '' ? NaN : Number(size)));
  if (!chunkSizes.every((size) => size === 'whole' || (Number.isInteger(size) && size > 0))) {
    return `--pacing-chunks must list positive whole numbers of bytes or "whole", got "${chunks}".`;
  }
  const delaysMs = list(delays).map((delay) => (delay === '' ? NaN : Number(delay)));
  if (!delaysMs.every((delay) => Number.isFinite(delay) && delay >= 0)) {
    return `--pacing-delays must list milliseconds of 0 or more, got "${delays}".`;
  }
  const count = Number(repeats);
  if (!Number.isInteger(count) || count < 1) return `--pacing-repeats must be a whole number of 1 or more, got "${repeats}".`;
  return { chunkSizes, delaysMs, repeats: count };
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
