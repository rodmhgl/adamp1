import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DUMP_TIMEOUT_MS, selectProbes } from '../probe-runner.js';
import { runSession, type SessionOptions, type SessionReport } from '../session.js';
import { memoryImage, memoryImageRequest } from '../testing/frames.js';
import { ScriptedOperator } from '../testing/scripted-operator.js';
import { ScriptedPort, type ScriptStep } from '../testing/scripted-port.js';
import { memoryImageDumpProbe, type MemoryImageDumpResult } from './memory-image-dump.js';

// MIDI channel 1 (00 on the wire). Checksum: 0D + 00 + 0A + 01 = 24; 128 - 24 = 104 = 0x68.
const REQUEST = [0xf0, 0x0d, 0x00, 0x0a, 0x01, 0x68, 0xf7];

/** Memory n holds Overdrive 1 n - 1 (0–127), so every Memory differs and the order shows. */
const PROGRAMS = Array.from({ length: 128 }, (_, i) => [i, 20, 16, 3, 4, 5, 6, 0, 50, 25, 1]);
const MEMORY_IMAGE_REPLY = memoryImage(0, PROGRAMS);

const CONNECTION = { input: 'UM-ONE In', output: 'UM-ONE Out', channel: 1 };

describe('Memory Image dump probe', () => {
  let sessionDir: string;
  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), 'adamp1-dump-'));
  });
  afterEach(() => rm(sessionDir, { recursive: true, force: true }));

  async function runDump(script: ScriptStep[], options: Partial<SessionOptions> = {}) {
    const port = new ScriptedPort(script);
    const report = await runSession({
      port,
      operator: new ScriptedOperator(['2.01']),
      connection: CONNECTION,
      timeoutMs: 10,
      dumpTimeoutMs: 50,
      probes: [memoryImageDumpProbe],
      sessionDir,
      ...options,
    });
    const saved: SessionReport = JSON.parse(await readFile(join(sessionDir, 'report.json'), 'utf8'));
    expect(saved).toEqual(report);
    return { port, report, probe: report.probes[0]!, data: report.probes[0]!.data as MemoryImageDumpResult | undefined };
  }

  async function savedFiles(): Promise<string[]> {
    return (await readdir(sessionDir)).filter((name) => name !== 'capture.log' && name !== 'report.json');
  }

  it('leaves the unit as it was, so "all non-destructive" includes it', () => {
    expect(memoryImageDumpProbe.kind).toBe('non-destructive');
    expect(selectProbes([memoryImageDumpProbe], { allNonDestructive: true })).toEqual([memoryImageDumpProbe]);
  });

  it('saves a valid Memory Image as a raw .syx capture and a decoded report, times it, and records it as the backup', async () => {
    expect(memoryImageRequest(0)).toEqual(REQUEST);
    expect(MEMORY_IMAGE_REPLY).toHaveLength(7 + 128 * 11);

    const { port, report, probe, data } = await runDump([{ expect: REQUEST, reply: [MEMORY_IMAGE_REPLY] }]);

    expect(port.unexpected).toEqual([]);
    expect(port.sent).toEqual([REQUEST]);
    expect(probe.verdict).toBe('confirmed');
    expect(probe.summary).toMatch(/128 Programs/);

    expect(data?.durationMs).toBeGreaterThanOrEqual(0);
    expect(probe.findings.join('\n')).toMatch(/took \d+ ms/);

    expect(report.backup).toEqual({
      probe: 'memory-image-dump',
      savedAt: expect.stringMatching(/^\d{4}-/),
      syxFile: data?.backup.syxFile,
      decodedFile: data?.backup.decodedFile,
    });
    const syx = await readFile(join(sessionDir, report.backup!.syxFile));
    expect([...syx]).toEqual(MEMORY_IMAGE_REPLY);

    const decoded = JSON.parse(await readFile(join(sessionDir, report.backup!.decodedFile), 'utf8'));
    expect(decoded.parameters[0]).toBe('Overdrive 1');
    expect(decoded.memories).toHaveLength(128);
    expect(decoded.memories[0]).toEqual({ memory: 1, raw: PROGRAMS[0] });
    expect(decoded.memories[127]).toEqual({ memory: 128, raw: PROGRAMS[127] });
  });

  it("ignores other manufacturers' SysEx arriving before the Memory Image", async () => {
    const universalIdentityReply = [0xf0, 0x7e, 0x00, 0x06, 0x02, 0x41, 0x00, 0xf7];

    const { probe, report } = await runDump([{ expect: REQUEST, reply: [universalIdentityReply, MEMORY_IMAGE_REPLY] }]);

    expect(probe.verdict).toBe('confirmed');
    expect(report.backup).toBeDefined();
  });

  it('rejects a truncated reply, names the reason and records no backup', async () => {
    const truncated = [...MEMORY_IMAGE_REPLY.slice(0, 5 + 100 * 11), ...MEMORY_IMAGE_REPLY.slice(-2)];

    const { probe, report } = await runDump([{ expect: REQUEST, reply: [truncated] }]);

    expect(probe.verdict).not.toBe('confirmed');
    expect(probe.summary).toMatch(/truncated/i);
    expect(probe.findings.join('\n')).toMatch(/1100 of 1408 data bytes/);
    expect(report.backup).toBeUndefined();
    expect(await savedFiles()).toEqual([]);
  });

  it('rejects a reply that stops without an F7 as truncated', async () => {
    const { probe, report } = await runDump([{ expect: REQUEST, reply: [MEMORY_IMAGE_REPLY.slice(0, 600)] }]);

    expect(probe.verdict).not.toBe('confirmed');
    expect(probe.summary).toMatch(/truncated/i);
    expect(report.backup).toBeUndefined();
  });

  it('refutes the 128-Program hypothesis when a too-long reply passes its checksum', async () => {
    const tooLong = memoryImage(0, [...PROGRAMS, PROGRAMS[0]!]);

    const { probe, report } = await runDump([{ expect: REQUEST, reply: [tooLong] }]);

    expect(probe.verdict).toBe('refuted');
    expect(probe.summary).toMatch(/too long/i);
    expect(probe.findings.join('\n')).toMatch(/1419 data bytes, expected 1408/);
    expect(report.backup).toBeUndefined();
    expect(await savedFiles()).toEqual([]);
  });

  it('rejects a reply that fails its checksum, names the mismatch and records no backup', async () => {
    const corrupted = [...MEMORY_IMAGE_REPLY];
    corrupted[500] = (corrupted[500]! + 1) % 128;

    const { probe, report } = await runDump([{ expect: REQUEST, reply: [corrupted] }]);

    expect(probe.verdict).toBe('inconclusive');
    expect(probe.summary).toMatch(/checksum/i);
    expect(probe.findings.join('\n')).toMatch(/checksum mismatch: received [0-9A-F]{2}, computed [0-9A-F]{2}/);
    expect(report.backup).toBeUndefined();
    expect(await savedFiles()).toEqual([]);
  });

  it('waits for the dump timeout, not the per-reply timeout, and says so when nothing arrives', async () => {
    const { probe, report } = await runDump([{ expect: REQUEST, reply: [] }], { timeoutMs: 5, dumpTimeoutMs: 40 });

    expect(probe.verdict).toBe('inconclusive');
    expect(probe.summary).toMatch(/no reply .* 40 ms/i);
    expect(report.dumpTimeoutMs).toBe(40);
    expect(report.backup).toBeUndefined();
  });

  it('gives the dump a generous timeout of several seconds by default', async () => {
    expect(DEFAULT_DUMP_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
    const { report } = await runDump([{ expect: REQUEST, reply: [MEMORY_IMAGE_REPLY] }], { dumpTimeoutMs: undefined });
    expect(report.dumpTimeoutMs).toBe(DEFAULT_DUMP_TIMEOUT_MS);
  });
});
