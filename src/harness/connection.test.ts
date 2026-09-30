import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chooseConnection, loadConnection, saveConnection } from './connection.js';
import { ScriptedOperator } from './testing/scripted-operator.js';

const PORTS = {
  inputs: ['Loopback In', 'UM-ONE In'],
  outputs: ['Loopback Out', 'UM-ONE Out'],
};

describe('choosing the MIDI connection', () => {
  let dir: string;
  let settingsFile: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'adamp1-connection-'));
    settingsFile = join(dir, 'harness.json');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('lists the ports and takes a number or an exact name, with no defaults the first time', async () => {
    const operator = new ScriptedOperator(['2', 'UM-ONE Out', '5']);

    const connection = await chooseConnection(operator, PORTS, await loadConnection(settingsFile));

    expect(connection).toEqual({ input: 'UM-ONE In', output: 'UM-ONE Out', channel: 5 });
    const asked = operator.events;
    expect(asked.map((event) => event.kind)).toEqual(['ask', 'ask', 'ask']);
    expect(asked.every((event) => !('defaultAnswer' in event))).toBe(true);
    expect(asked[0]).toMatchObject({ question: expect.stringMatching(/input[\s\S]*1\) Loopback In[\s\S]*2\) UM-ONE In/) });
    expect(asked[1]).toMatchObject({ question: expect.stringMatching(/output[\s\S]*1\) Loopback Out[\s\S]*2\) UM-ONE Out/) });
    expect(asked[2]).toMatchObject({ question: expect.stringMatching(/channel.*1.16/i) });
  });

  it('remembers the choice and offers it as the default next session', async () => {
    const first = await chooseConnection(new ScriptedOperator(['2', '2', '5']), PORTS, await loadConnection(settingsFile));
    await saveConnection(settingsFile, first);

    const operator = new ScriptedOperator(['', '', '']);
    const second = await chooseConnection(operator, PORTS, await loadConnection(settingsFile));

    expect(second).toEqual({ input: 'UM-ONE In', output: 'UM-ONE Out', channel: 5 });
    expect(operator.events.map((event) => 'defaultAnswer' in event && event.defaultAnswer)).toEqual([
      'UM-ONE In',
      'UM-ONE Out',
      '5',
    ]);
  });

  it('does not offer a remembered port that is no longer connected', async () => {
    await saveConnection(settingsFile, { input: 'Gone In', output: 'UM-ONE Out', channel: 1 });
    const operator = new ScriptedOperator(['1', '', '']);

    const connection = await chooseConnection(operator, PORTS, await loadConnection(settingsFile));

    expect(connection).toEqual({ input: 'Loopback In', output: 'UM-ONE Out', channel: 1 });
    expect('defaultAnswer' in operator.events[0]!).toBe(false);
  });

  it('warns and asks again after an answer that is not a port or a channel', async () => {
    const operator = new ScriptedOperator(['3', 'UM-ONE', '1', '1', '17', '0', 'x', '16']);

    const connection = await chooseConnection(operator, PORTS, undefined);

    expect(connection).toEqual({ input: 'Loopback In', output: 'Loopback Out', channel: 16 });
    expect(operator.events.map((event) => event.kind)).toEqual([
      'ask', 'warn', 'ask', 'warn', 'ask',
      'ask',
      'ask', 'warn', 'ask', 'warn', 'ask', 'warn', 'ask',
    ]);
  });

  it('treats a missing or unreadable settings file as nothing remembered', async () => {
    expect(await loadConnection(join(dir, 'missing.json'))).toBeUndefined();
    await writeFile(settingsFile, '{ not json');
    expect(await loadConnection(settingsFile)).toBeUndefined();
    await writeFile(settingsFile, JSON.stringify({ input: 'UM-ONE In', output: 'UM-ONE Out', channel: 17 }));
    expect(await loadConnection(settingsFile)).toBeUndefined();
  });
});
