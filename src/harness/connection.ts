import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PortNames } from './jzz-port.js';
import type { Operator } from './operator.js';

/** The ports and channel a session talks to the unit on. */
export interface Connection {
  input: string;
  output: string;
  /** MIDI channel as the unit shows it, 1–16. */
  channel: number;
}

export function isMidiChannel(channel: number): boolean {
  return Number.isInteger(channel) && channel >= 1 && channel <= 16;
}

/** Where the last connection is remembered: the per-user config folder on each OS. */
export function defaultSettingsFile(): string {
  const configHome = process.env.APPDATA ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(configHome, 'adamp1', 'harness.json');
}

export async function loadConnection(file: string): Promise<Connection | undefined> {
  try {
    const saved: unknown = JSON.parse(await readFile(file, 'utf8'));
    return isConnection(saved) ? saved : undefined;
  } catch {
    return undefined;
  }
}

export async function saveConnection(file: string, connection: Connection): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(connection, null, 2)}\n`);
}

/**
 * Asks the operator for the input port, output port and channel, offering the
 * remembered connection as defaults where its ports are still present.
 */
export async function chooseConnection(
  operator: Operator,
  available: PortNames,
  remembered: Connection | undefined,
): Promise<Connection> {
  const input = await choosePort(operator, 'input', available.inputs, remembered?.input);
  const output = await choosePort(operator, 'output', available.outputs, remembered?.output);
  const channel = await askUntil(
    operator,
    'MIDI channel the unit is set to (1-16)',
    remembered && String(remembered.channel),
    (answer) => {
      const channel = Number(answer);
      return /^\d+$/.test(answer) && isMidiChannel(channel) ? channel : undefined;
    },
    (answer) => `"${answer}" is not a MIDI channel from 1 to 16.`,
  );
  return { input, output, channel };
}

function choosePort(
  operator: Operator,
  direction: 'input' | 'output',
  names: string[],
  remembered: string | undefined,
): Promise<string> {
  const list = names.map((name, i) => `  ${i + 1}) ${name}`).join('\n');
  return askUntil(
    operator,
    `MIDI ${direction} port:\n${list}\nEnter a number or the exact name`,
    remembered !== undefined && names.includes(remembered) ? remembered : undefined,
    (answer) => (names.includes(answer) ? answer : /^\d+$/.test(answer) ? names[Number(answer) - 1] : undefined),
    (answer) => `"${answer}" is not one of the listed ${direction} ports.`,
  );
}

async function askUntil<T>(
  operator: Operator,
  question: string,
  defaultAnswer: string | undefined,
  parse: (answer: string) => T | undefined,
  complaint: (answer: string) => string,
): Promise<T> {
  for (;;) {
    const answer = (await operator.ask(question, defaultAnswer)).trim();
    const parsed = parse(answer);
    if (parsed !== undefined) return parsed;
    operator.warn(complaint(answer));
  }
}

function isConnection(value: unknown): value is Connection {
  if (typeof value !== 'object' || value === null) return false;
  const { input, output, channel } = value as Record<string, unknown>;
  return (
    typeof input === 'string' &&
    typeof output === 'string' &&
    typeof channel === 'number' &&
    isMidiChannel(channel)
  );
}
