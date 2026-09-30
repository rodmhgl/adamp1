import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSession } from '../session.js';
import { memoryImage, memoryImageRequest } from '../testing/frames.js';
import { DONE, ScriptedOperator, type OperatorAnswer } from '../testing/scripted-operator.js';
import { ScriptedPort, type ScriptStep } from '../testing/scripted-port.js';
import { memoryImageDumpProbe } from './memory-image-dump.js';
import { restoreProbe } from './restore.js';

// MIDI channel 2 (01 on the wire): the saved file's own channel doesn't matter.
const DUMP_REQUEST = memoryImageRequest(1);

const ON_UNIT = Array.from({ length: 128 }, (_, i) => [i, 20, 16, 3, 4, 5, 6, 0, 50, 25, 1]);
/** The saved Memory Image differs from what the unit holds in Memories 1, 2 and 128. */
const SAVED = ON_UNIT.map((program, i) => (i === 0 || i === 1 || i === 127 ? [...program.slice(0, 10), 2] : program));
const SAVED_IMAGE = { programs: SAVED.map((raw) => ({ raw })) };

const CONNECTION = { input: 'UM-ONE In', output: 'UM-ONE Out', channel: 2 };

describe('restore command', () => {
  let sessionDir: string;
  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), 'adamp1-restore-'));
  });
  afterEach(() => rm(sessionDir, { recursive: true, force: true }));

  async function runRestore(script: ScriptStep[], answers: OperatorAnswer[]) {
    const port = new ScriptedPort(script);
    const operator = new ScriptedOperator(['2.01', ...answers]);
    const report = await runSession({
      port,
      operator,
      connection: CONNECTION,
      timeoutMs: 10,
      dumpTimeoutMs: 50,
      probes: [memoryImageDumpProbe, restoreProbe('old-session/memory-image-1.syx', SAVED_IMAGE)],
      sessionDir,
    });
    return { port, operator, report, restore: report.probes.find(({ probe }) => probe === 'restore')! };
  }

  it('writes Memories, with the same confirmation, and keeps the checked result as the new backup', async () => {
    const { port, operator, report, restore } = await runRestore(
      [
        { expect: DUMP_REQUEST, reply: [memoryImage(1, ON_UNIT)] },
        { expect: memoryImage(1, SAVED), reply: [] },
        { expect: DUMP_REQUEST, reply: [memoryImage(1, SAVED)] },
      ],
      [true, DONE],
    );

    expect(port.unexpected).toEqual([]);
    expect(port.sent).toHaveLength(3);
    expect(restore.kind).toBe('writes-memories');
    expect(restore.verdict).toBe('confirmed');
    expect(restore.summary).toMatch(/Restored old-session\/memory-image-1\.syx/);
    expect(operator.events.slice(1)).toEqual([
      { kind: 'confirm', question: expect.stringMatching(/changes 3 of 128 Memories/) },
      { kind: 'instruct', instruction: expect.stringMatching(/Protect OFF/) },
    ]);

    // The Memory Image the unit held before is kept as the first backup; the restored one is the latest.
    expect(report.backup).toMatchObject({ probe: 'restore', syxFile: 'memory-image-2.syx' });
    expect([...(await readFile(join(sessionDir, 'memory-image-1.syx')))]).toEqual(memoryImage(1, ON_UNIT));
    expect([...(await readFile(join(sessionDir, 'memory-image-2.syx')))]).toEqual(memoryImage(1, SAVED));
  });

  it('sends nothing when the maintainer declines', async () => {
    const { port, restore } = await runRestore([{ expect: DUMP_REQUEST, reply: [memoryImage(1, ON_UNIT)] }], [false]);

    expect(port.sent).toEqual([DUMP_REQUEST]);
    expect(restore.summary).toMatch(/declined/);
  });

  it('refutes a restore that reads back differently, and puts back what the unit held', async () => {
    const partial = SAVED.map((program, i) => (i === 127 ? ON_UNIT[127]! : program));

    const { port, report, restore } = await runRestore(
      [
        { expect: DUMP_REQUEST, reply: [memoryImage(1, ON_UNIT)] },
        { expect: memoryImage(1, SAVED), reply: [] },
        { expect: DUMP_REQUEST, reply: [memoryImage(1, partial)] },
        { expect: memoryImage(1, ON_UNIT), reply: [] },
        { expect: DUMP_REQUEST, reply: [memoryImage(1, ON_UNIT)] },
      ],
      [true, DONE],
    );

    expect(port.unexpected).toEqual([]);
    expect(restore.verdict).toBe('refuted');
    expect(restore.findings.join('\n')).toMatch(/Memory 128: Voicing loaded 2, read back 1/);
    expect(restore.findings.join('\n')).toMatch(/Restored the backup memory-image-1\.syx/);
    expect(report.backup?.syxFile).toBe('memory-image-1.syx');
  });
});
