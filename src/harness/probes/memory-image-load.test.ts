import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selectProbes, type Probe } from '../probe-runner.js';
import { runSession, type SessionOptions } from '../session.js';
import { memoryImage, memoryImageRequest } from '../testing/frames.js';
import { DONE, ScriptedOperator, type OperatorAnswer } from '../testing/scripted-operator.js';
import { ScriptedPort, type ScriptStep } from '../testing/scripted-port.js';
import { memoryImageDumpProbe } from './memory-image-dump.js';
import { memoryImageLoadProbe, type MemoryImageLoadResult } from './memory-image-load.js';

// MIDI channel 1 (00 on the wire).
const DUMP_REQUEST = memoryImageRequest(0);

/** Memory n holds Overdrive 1 n - 1, so every Memory differs and the order shows. */
const BACKUP = Array.from({ length: 128 }, (_, i) => [i, 20, 16, 3, 4, 5, 6, 0, 50, 25, 1]);
/** The test image the probe loads: Memory n gets the backup's Memory n + 1, and Memory 128 gets Memory 1. */
const ROTATED = [...BACKUP.slice(1), BACKUP[0]!];

const BACKUP_DUMP: ScriptStep = { expect: DUMP_REQUEST, reply: [memoryImage(0, BACKUP)] };
const LOAD_TEST_IMAGE: ScriptStep = { expect: memoryImage(0, ROTATED), reply: [] };
/** What the runner sends after the probe to put the backup back, and the dump that checks it. */
const RESTORE_BACKUP: ScriptStep[] = [
  { expect: memoryImage(0, BACKUP), reply: [] },
  { expect: DUMP_REQUEST, reply: [memoryImage(0, BACKUP)] },
];

const CONNECTION = { input: 'UM-ONE In', output: 'UM-ONE Out', channel: 1 };

describe('Memory Image load probe', () => {
  let sessionDir: string;
  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), 'adamp1-load-'));
  });
  afterEach(() => rm(sessionDir, { recursive: true, force: true }));

  async function runLoad(
    script: ScriptStep[],
    answers: OperatorAnswer[],
    options: Partial<SessionOptions> = {},
  ) {
    const port = new ScriptedPort(script);
    const operator = new ScriptedOperator(['2.01', ...answers]);
    const report = await runSession({
      port,
      operator,
      connection: CONNECTION,
      timeoutMs: 10,
      dumpTimeoutMs: 50,
      probes: [memoryImageDumpProbe, memoryImageLoadProbe],
      sessionDir,
      ...options,
    });
    const load = report.probes.find(({ probe }) => probe === 'memory-image-load');
    return { port, operator, report, load, data: load?.data as MemoryImageLoadResult | undefined };
  }

  it('declares that it writes Memories, so "all non-destructive" leaves it out', () => {
    expect(memoryImageLoadProbe.kind).toBe('writes-memories');
    expect(selectProbes([memoryImageLoadProbe], { allNonDestructive: true })).toEqual([]);
  });

  it('is refused when the session has no verified backup, and sends nothing', async () => {
    const { port, operator, load } = await runLoad([], [], { probes: [memoryImageLoadProbe] });

    expect(port.sent).toEqual([]);
    expect(load?.verdict).toBe('inconclusive');
    expect(load?.summary).toMatch(/refused.*no verified backup/i);
    expect(operator.events.map(({ kind }) => kind)).toEqual(['ask']);
  });

  it('is refused when the dump before it fails, so no backup was kept', async () => {
    const { port, load } = await runLoad([{ expect: DUMP_REQUEST, reply: [] }], []);

    expect(port.sent).toEqual([DUMP_REQUEST]);
    expect(load?.summary).toMatch(/no verified backup/i);
  });

  it('asks for confirmation with the number of Memories that will change, and sends nothing when declined', async () => {
    const { port, operator, load } = await runLoad([BACKUP_DUMP], [false]);

    expect(port.unexpected).toEqual([]);
    expect(port.sent).toEqual([DUMP_REQUEST]);
    expect(load?.verdict).toBe('inconclusive');
    expect(load?.summary).toMatch(/declined.*nothing was written/i);
    expect(operator.events.slice(1)).toEqual([
      { kind: 'confirm', question: expect.stringMatching(/changes 128 of 128 Memories/) },
    ]);
  });

  it('confirms a lossless round trip: loads, dumps back, finds no difference, and restores the backup', async () => {
    const { port, operator, load, data } = await runLoad(
      [BACKUP_DUMP, LOAD_TEST_IMAGE, { expect: DUMP_REQUEST, reply: [memoryImage(0, ROTATED)] }, ...RESTORE_BACKUP],
      [true, DONE],
    );

    expect(port.unexpected).toEqual([]);
    expect(port.sent).toEqual([DUMP_REQUEST, memoryImage(0, ROTATED), DUMP_REQUEST, memoryImage(0, BACKUP), DUMP_REQUEST]);
    expect(load?.verdict).toBe('confirmed');
    expect(load?.summary).toMatch(/matches .* all 128 Memories/);
    expect(data).toEqual({ changedMemories: 128, differences: [] });
    expect(load?.findings.join('\n')).toMatch(/Restored the backup .*memory-image-1\.syx.*matches/);

    // Protect OFF is asked for after the confirmation and before anything is written.
    expect(operator.events.slice(1)).toEqual([
      { kind: 'confirm', question: expect.stringMatching(/changes 128 of 128 Memories/) },
      { kind: 'instruct', instruction: expect.stringMatching(/Protect OFF[\s\S]*Store, then Bank\+8/) },
    ]);
  });

  it('reports every Memory that reads back differently after the load, and still restores the backup', async () => {
    const readBack = ROTATED.map((program) => [...program]);
    readBack[4]![3] = 9; // Memory 5, Bass
    readBack[99]![0] = 0; // Memory 100, Overdrive 1

    const { port, load, data } = await runLoad(
      [BACKUP_DUMP, LOAD_TEST_IMAGE, { expect: DUMP_REQUEST, reply: [memoryImage(0, readBack)] }, ...RESTORE_BACKUP],
      [true, DONE],
    );

    expect(port.unexpected).toEqual([]);
    expect(port.sent).toHaveLength(5);
    expect(load?.verdict).toBe('refuted');
    expect(load?.summary).toMatch(/2 of 128 Memories/);
    const findings = load?.findings.join('\n');
    expect(findings).toMatch(/Memory 5: Bass loaded 3, read back 9/);
    expect(findings).toMatch(/Memory 100: Overdrive 1 loaded 100, read back 0/);
    expect(data?.differences.map(({ memory }) => memory)).toEqual([5, 100]);
    expect(findings).toMatch(/Restored the backup/);
  });

  it('says the load was ignored, and restores nothing, when the unit still holds the backup afterwards', async () => {
    const { port, load } = await runLoad([BACKUP_DUMP, LOAD_TEST_IMAGE, BACKUP_DUMP], [true, DONE]);

    expect(port.unexpected).toEqual([]);
    expect(port.sent).toEqual([DUMP_REQUEST, memoryImage(0, ROTATED), DUMP_REQUEST]);
    expect(load?.verdict).toBe('inconclusive');
    expect(load?.summary).toMatch(/ignored/i);
    expect(load?.findings.join('\n')).toMatch(/Protect/);
  });

  it('restores the backup when stopped part-way, and runs no further probes', async () => {
    const stop = new AbortController();
    const laterProbe: Probe<undefined> = {
      name: 'later',
      kind: 'non-destructive',
      run: () => Promise.reject(new Error('must not run')),
    };

    const { port, report, load } = await runLoad(
      [BACKUP_DUMP, { ...LOAD_TEST_IMAGE, afterSend: () => stop.abort() }, ...RESTORE_BACKUP],
      [true, DONE],
      { signal: stop.signal, probes: [memoryImageDumpProbe, memoryImageLoadProbe, laterProbe] },
    );

    expect(port.unexpected).toEqual([]);
    expect(port.sent).toEqual([DUMP_REQUEST, memoryImage(0, ROTATED), memoryImage(0, BACKUP), DUMP_REQUEST]);
    expect(load?.verdict).toBe('inconclusive');
    expect(load?.summary).toMatch(/stopped/i);
    expect(load?.findings.join('\n')).toMatch(/Restored the backup/);
    expect(report.probes.map(({ probe }) => probe)).toEqual(['memory-image-dump', 'memory-image-load']);
  });

  it('sends nothing, and so restores nothing, when stopped during the Protect OFF instruction', async () => {
    const stop = new AbortController();
    const port = new ScriptedPort([BACKUP_DUMP]);
    const operator = new ScriptedOperator(['2.01', true, DONE]);
    const instruct = operator.instruct.bind(operator);
    operator.instruct = async (instruction) => {
      await instruct(instruction);
      stop.abort();
    };

    const report = await runSession({
      port,
      operator,
      connection: CONNECTION,
      timeoutMs: 10,
      dumpTimeoutMs: 50,
      probes: [memoryImageDumpProbe, memoryImageLoadProbe],
      sessionDir,
      signal: stop.signal,
    });

    expect(port.sent).toEqual([DUMP_REQUEST]);
    expect(report.probes[1]?.summary).toMatch(/stopped/i);
    expect(report.probes[1]?.findings.join('\n')).not.toMatch(/Restored/);
  });

  it('warns, naming the backup to restore from, when the restore does not read back as the backup', async () => {
    const { load } = await runLoad(
      [
        BACKUP_DUMP,
        LOAD_TEST_IMAGE,
        { expect: DUMP_REQUEST, reply: [memoryImage(0, ROTATED)] },
        { expect: memoryImage(0, BACKUP), reply: [] },
        { expect: DUMP_REQUEST, reply: [memoryImage(0, ROTATED)] },
      ],
      [true, DONE],
    );

    expect(load?.verdict).toBe('confirmed');
    expect(load?.findings.join('\n')).toMatch(/WARNING: .*restore.*128 Memories differ.*--restore .*memory-image-1\.syx/);
  });
});
