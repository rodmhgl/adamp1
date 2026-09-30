import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selectProbes } from '../probe-runner.js';
import { runSession, type SessionOptions } from '../session.js';
import { memoryImage, memoryImageRequest } from '../testing/frames.js';
import { DONE, ScriptedOperator, type OperatorAnswer } from '../testing/scripted-operator.js';
import { ScriptedPort, type ScriptStep } from '../testing/scripted-port.js';
import { memoryImageDumpProbe } from './memory-image-dump.js';
import { protectOnLoadProbe, type ProtectOnLoadResult } from './protect-on-load.js';

// MIDI channel 1 (00 on the wire).
const DUMP_REQUEST = memoryImageRequest(0);

/** Memory n holds Overdrive 1 n - 1, so every Memory differs and the order shows. */
const BACKUP = Array.from({ length: 128 }, (_, i) => [i, 20, 16, 3, 4, 5, 6, 0, 50, 25, 1]);
/** The test image the probe loads: the backup with its Memories rotated by one. */
const ROTATED = [...BACKUP.slice(1), BACKUP[0]!];
/** The unit wrote Memories 1–10 of the test image and kept the backup in the rest. */
const PARTIAL = [...ROTATED.slice(0, 10), ...BACKUP.slice(10)];
/** A hypothetical ADA SysEx answer to the refused load. */
const ERROR_REPLY = [0xf0, 0x0d, 0x00, 0x0c, 0x01, 0x66, 0xf7];

const BACKUP_DUMP: ScriptStep = { expect: DUMP_REQUEST, reply: [memoryImage(0, BACKUP)] };
const LOAD_TEST_IMAGE: ScriptStep = { expect: memoryImage(0, ROTATED), reply: [] };
const RESTORE_BACKUP: ScriptStep[] = [
  { expect: memoryImage(0, BACKUP), reply: [] },
  { expect: DUMP_REQUEST, reply: [memoryImage(0, BACKUP)] },
];

const CONNECTION = { input: 'UM-ONE In', output: 'UM-ONE Out', channel: 1 };

describe('Protect ON load probe', () => {
  let sessionDir: string;
  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), 'adamp1-protect-'));
  });
  afterEach(() => rm(sessionDir, { recursive: true, force: true }));

  async function runProtectedLoad(script: ScriptStep[], answers: OperatorAnswer[], options: Partial<SessionOptions> = {}) {
    const port = new ScriptedPort(script);
    const operator = new ScriptedOperator(['2.01', ...answers]);
    const report = await runSession({
      port,
      operator,
      connection: CONNECTION,
      timeoutMs: 10,
      dumpTimeoutMs: 50,
      probes: [memoryImageDumpProbe, protectOnLoadProbe],
      sessionDir,
      ...options,
    });
    const load = report.probes.find(({ probe }) => probe === 'protect-on-load');
    return { port, operator, load, data: load?.data as ProtectOnLoadResult | undefined };
  }

  it('declares that it writes Memories, so "all non-destructive" leaves it out', () => {
    expect(protectOnLoadProbe.kind).toBe('writes-memories');
    expect(selectProbes([protectOnLoadProbe], { allNonDestructive: true })).toEqual([]);
  });

  it('is refused when the session has no verified backup, and sends nothing', async () => {
    const { port, load } = await runProtectedLoad([], [], { probes: [protectOnLoadProbe] });

    expect(port.sent).toEqual([]);
    expect(load?.summary).toMatch(/refused.*no verified backup/i);
  });

  it('asks for Protect ON, not OFF, after the confirmation and before the load', async () => {
    const { operator } = await runProtectedLoad([BACKUP_DUMP, LOAD_TEST_IMAGE, BACKUP_DUMP], [true, DONE]);

    expect(operator.events.slice(1)).toEqual([
      { kind: 'confirm', question: expect.stringMatching(/changes 128 of 128 Memories/) },
      { kind: 'instruct', instruction: expect.stringMatching(/Protect ON[\s\S]*Store, then Bank\+8/) },
    ]);
  });

  it('records a silent refusal: no reply, the dump still holds the backup, and nothing is restored', async () => {
    const { port, operator, load, data } = await runProtectedLoad([BACKUP_DUMP, LOAD_TEST_IMAGE, BACKUP_DUMP], [true, DONE]);

    expect(port.unexpected).toEqual([]);
    expect(port.sent).toEqual([DUMP_REQUEST, memoryImage(0, ROTATED), DUMP_REQUEST]);
    expect(load?.verdict).toBe('confirmed');
    expect(load?.summary).toMatch(/refused .* silently/i);
    expect(data).toEqual({ outcome: 'silence', changedMemories: [] });
    const findings = load?.findings.join('\n');
    expect(findings).toMatch(/no reply within 10 ms/i);
    expect(findings).toMatch(/all 128 Memories still hold the backup/);
    expect(findings).toMatch(/Protect is left ON/);
    expect(findings).not.toMatch(/Restored/);
    expect(operator.events.filter(({ kind }) => kind === 'instruct')).toHaveLength(1);
  });

  it('records an error reply with its bytes when the unit answers the refused load', async () => {
    const { port, load, data } = await runProtectedLoad(
      [BACKUP_DUMP, { ...LOAD_TEST_IMAGE, reply: [ERROR_REPLY] }, BACKUP_DUMP],
      [true, DONE],
    );

    expect(port.unexpected).toEqual([]);
    expect(load?.verdict).toBe('confirmed');
    expect(load?.summary).toMatch(/refused .* F0 0D 00 0C 01 66 F7/);
    expect(data).toEqual({ outcome: 'error-reply', reply: ERROR_REPLY, changedMemories: [] });
  });

  it('records a partial write, lists the Memories written, and restores the backup with Protect OFF', async () => {
    const { port, operator, load, data } = await runProtectedLoad(
      [BACKUP_DUMP, LOAD_TEST_IMAGE, { expect: DUMP_REQUEST, reply: [memoryImage(0, PARTIAL)] }, ...RESTORE_BACKUP],
      [true, DONE, DONE],
    );

    expect(port.unexpected).toEqual([]);
    expect(port.sent).toEqual([DUMP_REQUEST, memoryImage(0, ROTATED), DUMP_REQUEST, memoryImage(0, BACKUP), DUMP_REQUEST]);
    expect(load?.verdict).toBe('refuted');
    expect(load?.summary).toMatch(/partly .* 10 of 128 Memories/);
    expect(data).toEqual({ outcome: 'partial-write', changedMemories: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
    const findings = load?.findings.join('\n');
    expect(findings).toMatch(/Memory 1: Overdrive 1 was 0, read back 1/);
    expect(findings).toMatch(/Restored the backup .*memory-image-1\.syx.*matches/);

    // Protect OFF is asked for after the probe, before the restore is sent.
    expect(operator.events.slice(1)).toEqual([
      { kind: 'confirm', question: expect.stringMatching(/changes 128 of 128 Memories/) },
      { kind: 'instruct', instruction: expect.stringMatching(/Protect ON/) },
      { kind: 'instruct', instruction: expect.stringMatching(/Protect OFF[\s\S]*Store, then Bank\+8/) },
    ]);
  });

  it('records a full write, suggesting Protect was not ON, and restores the backup', async () => {
    const { load, data } = await runProtectedLoad(
      [BACKUP_DUMP, LOAD_TEST_IMAGE, { expect: DUMP_REQUEST, reply: [memoryImage(0, ROTATED)] }, ...RESTORE_BACKUP],
      [true, DONE, DONE],
    );

    expect(load?.verdict).toBe('refuted');
    expect(load?.summary).toMatch(/accepted the whole Memory Image/);
    expect(load?.findings.join('\n')).toMatch(/check that Protect was ON/i);
    expect(data?.outcome).toBe('full-write');
    expect(data?.changedMemories).toHaveLength(128);
    expect(load?.findings.join('\n')).toMatch(/Restored the backup/);
  });

  it('is inconclusive when the dump after the load fails, and restores the backup with Protect OFF', async () => {
    const { port, load } = await runProtectedLoad(
      [BACKUP_DUMP, LOAD_TEST_IMAGE, { expect: DUMP_REQUEST, reply: [] }, ...RESTORE_BACKUP],
      [true, DONE, DONE],
    );

    expect(port.unexpected).toEqual([]);
    expect(load?.verdict).toBe('inconclusive');
    expect(load?.findings.join('\n')).toMatch(/No reply to the Memory Image request/);
    expect(load?.findings.join('\n')).toMatch(/Restored the backup/);
  });

  it('still sends the restore when it cannot ask for Protect OFF, and warns if it does not read back', async () => {
    const stop = new AbortController();
    const { port, load } = await runProtectedLoad(
      [
        BACKUP_DUMP,
        { ...LOAD_TEST_IMAGE, afterSend: () => stop.abort() },
        { expect: memoryImage(0, BACKUP), reply: [] },
        { expect: DUMP_REQUEST, reply: [memoryImage(0, PARTIAL)] },
      ],
      // No answer left for the Protect OFF instruction, as when the maintainer has stopped the run.
      [true, DONE],
      { signal: stop.signal },
    );

    expect(port.unexpected).toEqual([]);
    expect(load?.summary).toMatch(/stopped/i);
    expect(load?.findings.join('\n')).toMatch(/WARNING: .*10 Memories differ.*set Protect OFF.*--restore .*memory-image-1\.syx/);
  });
});
