import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selectProbes } from '../probe-runner.js';
import { runSession, type SessionOptions } from '../session.js';
import { memoryImage, memoryImageRequest } from '../testing/frames.js';
import { DONE, ScriptedOperator, type OperatorAnswer } from '../testing/scripted-operator.js';
import { SimulatedUnitPort, type Chunk } from '../testing/simulated-unit.js';
import { loadPacingProbe, type LoadPacingOptions, type LoadPacingResult } from './load-pacing.js';
import { memoryImageDumpProbe } from './memory-image-dump.js';

/** Memory n holds Overdrive 1 n - 1, so every Memory differs and the order shows. */
const BACKUP = Array.from({ length: 128 }, (_, i) => [i, 20, 16, 3, 4, 5, 6, 0, 50, 25, 1]);
/** The other image the probe loads: Memory n gets the backup's Memory n + 1, and Memory 128 gets Memory 1. */
const ROTATED = [...BACKUP.slice(1), BACKUP[0]!];
/** A Memory Image load is 1408 data bytes in a 7-byte frame. */
const LOAD_BYTES = memoryImage(0, BACKUP).length;

/** An interface whose buffer overflows on chunks over 600 bytes, and that loses a chunk following its message's previous one within 2 ms. */
const overflowsAndNeedsGaps = ({ bytes, continuation, msSincePrevious }: Chunk) =>
  bytes.length > 600 || (continuation && msSincePrevious < 2);

const CONNECTION = { input: 'UM-ONE In', output: 'UM-ONE Out', channel: 1 };

describe('load pacing probe', () => {
  let sessionDir: string;
  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), 'adamp1-pacing-'));
  });
  afterEach(() => rm(sessionDir, { recursive: true, force: true }));

  async function runPacing(
    options: LoadPacingOptions,
    drops: (chunk: Chunk) => boolean,
    answers: OperatorAnswer[] = [true, DONE],
    session: Partial<SessionOptions> = {},
  ) {
    const port = new SimulatedUnitPort({ image: BACKUP, drops });
    const operator = new ScriptedOperator(['2.01', ...answers]);
    const report = await runSession({
      port,
      operator,
      connection: CONNECTION,
      timeoutMs: 10,
      dumpTimeoutMs: 50,
      probes: [memoryImageDumpProbe, loadPacingProbe(options)],
      sessionDir,
      ...session,
    });
    const pacing = report.probes.find(({ probe }) => probe === 'load-pacing');
    return { port, operator, pacing, data: pacing?.data as LoadPacingResult | undefined };
  }

  it('declares that it writes Memories, so "all non-destructive" leaves it out', () => {
    const probe = loadPacingProbe({ chunkSizes: ['whole'], delaysMs: [0], repeats: 1 });
    expect(probe.kind).toBe('writes-memories');
    expect(selectProbes([probe], { allNonDestructive: true })).toEqual([]);
  });

  it('is refused when the session has no verified backup, and sends nothing', async () => {
    const port = new SimulatedUnitPort({ image: BACKUP });
    const report = await runSession({
      port,
      operator: new ScriptedOperator(['2.01']),
      connection: CONNECTION,
      timeoutMs: 10,
      probes: [loadPacingProbe({ chunkSizes: ['whole'], delaysMs: [0], repeats: 1 })],
      sessionDir,
    });

    expect(port.sent).toEqual([]);
    expect(report.probes[0]?.summary).toMatch(/refused.*no verified backup/i);
  });

  it('asks once for the whole series, and sends nothing when declined', async () => {
    const { port, operator, pacing } = await runPacing(
      { chunkSizes: ['whole', 512], delaysMs: [0, 5], repeats: 2 },
      () => false,
      [false],
    );

    expect(port.sent).toEqual([memoryImageRequest(0)]);
    expect(pacing?.summary).toMatch(/declined.*nothing was written/i);
    // Whole message, 512 bytes at 0 ms and at 5 ms: 3 settings, 2 loads each, and one to put the backup back.
    expect(operator.events.slice(1)).toEqual([{ kind: 'confirm', question: expect.stringMatching(/up to 7 times.*128 of 128 Memories/) }]);
  });

  it('reports the success rate of each setting and names the fastest fully reliable one', async () => {
    const { port, operator, pacing, data } = await runPacing(
      { chunkSizes: ['whole', 512], delaysMs: [0, 5], repeats: 2 },
      overflowsAndNeedsGaps,
    );

    expect(data?.settings.map(({ chunkBytes, delayMs, chunks, successes, attempts }) => ({ chunkBytes, delayMs, chunks, successes, attempts }))).toEqual([
      { chunkBytes: LOAD_BYTES, delayMs: 0, chunks: 1, successes: 0, attempts: 2 },
      { chunkBytes: 512, delayMs: 0, chunks: 3, successes: 0, attempts: 2 },
      { chunkBytes: 512, delayMs: 5, chunks: 3, successes: 2, attempts: 2 },
    ]);
    expect(data?.fastest).toEqual({ chunkBytes: 512, delayMs: 5 });
    expect(pacing?.verdict).toBe('confirmed');
    expect(pacing?.summary).toMatch(/fastest .*100%.*512-byte chunks, 5 ms apart/);
    const findings = pacing?.findings.join('\n');
    expect(findings).toMatch(/whole message.*0 of 2 .*\(0%\)/);
    expect(findings).toMatch(/512-byte chunks, 0 ms apart.*0 of 2 .*\(0%\)/);
    expect(findings).toMatch(/512-byte chunks, 5 ms apart.*2 of 2 .*\(100%\)/);

    // One confirmation and one Protect OFF instruction cover every load.
    expect(operator.events.slice(1).map(({ kind }) => kind)).toEqual(['confirm', 'instruct']);
    // Each 512-byte setting sent each load as three chunks.
    expect(port.sent.filter((chunk) => chunk.length === 512)).toHaveLength(8);
    // The second load of the reliable setting put the backup back, so nothing more was sent.
    expect(port.image).toEqual(BACKUP);
    expect(port.loads).toBe(2);
  });

  it('prefers a slower setting that never failed over a faster one that sometimes dropped data', async () => {
    let wholeLoads = 0;
    const { port, pacing, data } = await runPacing({ chunkSizes: ['whole', 512], delaysMs: [5], repeats: 3 }, ({ bytes }) => {
      if (bytes.length !== LOAD_BYTES) return false;
      wholeLoads++;
      return wholeLoads === 2;
    });

    expect(data?.settings.map(({ successes, attempts }) => `${successes}/${attempts}`)).toEqual(['2/3', '3/3']);
    expect(pacing?.findings.join('\n')).toMatch(/whole message.*2 of 3 .*\(67%\)/);
    expect(data?.fastest).toEqual({ chunkBytes: 512, delayMs: 5 });
    expect(pacing?.verdict).toBe('confirmed');

    // Three loads of the reliable setting left the rotated image in place, so the probe loaded
    // the backup back with that setting and checked it with a dump.
    expect(port.image).toEqual(BACKUP);
    expect(port.sent.slice(-4).map((chunk) => chunk.length)).toEqual([512, 512, LOAD_BYTES - 1024, memoryImageRequest(0).length]);
    expect(pacing?.findings.join('\n')).toMatch(/Loaded the backup .*512-byte chunks, 5 ms apart.*matches/);
    expect(pacing?.findings.join('\n')).not.toMatch(/WARNING/);
  });

  it('says no setting was reliable when every one dropped data, and leaves the backup in place', async () => {
    const { port, pacing, data } = await runPacing(
      { chunkSizes: ['whole'], delaysMs: [0], repeats: 2 },
      ({ bytes }) => bytes.length > 600,
    );

    expect(data?.fastest).toBeUndefined();
    expect(pacing?.verdict).toBe('inconclusive');
    expect(pacing?.summary).toMatch(/none .*reliable/i);
    expect(pacing?.findings.join('\n')).toMatch(/still held the image from before/i);
    expect(port.loads).toBe(0);
    expect(port.image).toEqual(BACKUP);
  });

  it('finds out what the unit holds after a failed dump, so a lost load never reads as a success', async () => {
    let loads = 0;
    let dumps = 0;
    const { pacing, data } = await runPacing({ chunkSizes: ['whole'], delaysMs: [0], repeats: 3 }, ({ bytes }) => {
      if (bytes.length === LOAD_BYTES) return ++loads <= 2; // The first two loads are lost…
      return bytes.length === memoryImageRequest(0).length && ++dumps === 2; // …and the dump checking the first.
    });

    expect(data?.settings.map(({ successes, attempts }) => `${successes}/${attempts}`)).toEqual(['1/3']);
    const findings = pacing?.findings.join('\n');
    expect(findings).toMatch(/Load 1 of 3 .*could not be checked/);
    expect(findings).toMatch(/Load 2 of 3 .*still held the image from before/);
  });

  it('restores the backup through the runner when stopped part-way, paced as the last load that read back', async () => {
    const stop = new AbortController();
    let loads = 0;
    const { port, pacing } = await runPacing(
      { chunkSizes: [512], delaysMs: [5], repeats: 3 },
      ({ bytes }) => {
        if (bytes.length === 512 && bytes[0] === 0xf0 && ++loads === 2) stop.abort();
        // This interface loses any whole Memory Image load, so a whole-message restore would fail.
        return bytes.length > 600;
      },
      [true, DONE],
      { signal: stop.signal },
    );

    expect(pacing?.summary).toMatch(/stopped/i);
    // The second load was still sent in full, never cut off part-way, and the runner then
    // loaded the backup back in 512-byte chunks.
    expect(port.sent.filter((chunk) => chunk.length === 512)).toHaveLength(6);
    expect(port.image).toEqual(BACKUP);
    expect(port.sent.at(-1)).toEqual(memoryImageRequest(0));
    expect(pacing?.findings.join('\n')).toMatch(/Restored the backup/);
  });
});
