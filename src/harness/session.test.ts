import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selectProbes, type Probe } from './probe-runner.js';
import { connectivityProbe } from './probes/connectivity.js';
import { runSession, type SessionReport } from './session.js';
import { ScriptedOperator } from './testing/scripted-operator.js';
import { ScriptedPort } from './testing/scripted-port.js';

// Channel 3 (02 on the wire); frames and checksums as worked out in connectivity.test.ts.
const REQUEST_WORKING_REGISTER_CH3 = [0xf0, 0x0d, 0x02, 0x08, 0x01, 0x68, 0xf7];
const WORKING_REGISTER_REPLY_CH3 = [
  0xf0, 0x0d, 0x02, 0x09, 0x01, 0x7f, 10, 20, 16, 3, 4, 5, 6, 1, 50, 25, 2, 0x5a, 0xf7,
];
const CONNECTION = { input: 'UM-ONE In', output: 'UM-ONE Out', channel: 3 };

/** Stand-ins for probes later tickets add, so selection can be checked against every kind. */
const PING = [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7];
const pingProbe: Probe<undefined> = {
  name: 'ping',
  kind: 'non-destructive',
  async run({ request }) {
    await request(Uint8Array.from(PING), () => true);
    return { verdict: 'inconclusive', summary: 'No answer.', findings: [] };
  },
};
const memoryWritingProbe: Probe<undefined> = {
  name: 'memory-write',
  kind: 'writes-memories',
  run: () => Promise.reject(new Error('must not run')),
};
const guidedProbe: Probe<undefined> = {
  name: 'guided',
  kind: 'guided',
  run: () => Promise.reject(new Error('must not run')),
};
const REGISTRY = [connectivityProbe, memoryWritingProbe, pingProbe, guidedProbe];

describe('a harness session', () => {
  let sessionDir: string;
  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), 'adamp1-session-'));
  });
  afterEach(() => rm(sessionDir, { recursive: true, force: true }));

  async function readReport(): Promise<SessionReport> {
    return JSON.parse(await readFile(join(sessionDir, 'report.json'), 'utf8')) as SessionReport;
  }

  it('asks for the firmware version from the power-up display and records it in the report', async () => {
    const operator = new ScriptedOperator(['2.01']);
    const port = new ScriptedPort([{ expect: REQUEST_WORKING_REGISTER_CH3, reply: [WORKING_REGISTER_REPLY_CH3] }]);

    await runSession({ port, operator, connection: CONNECTION, timeoutMs: 50, probes: [connectivityProbe], sessionDir });

    expect(operator.events).toEqual([
      { kind: 'ask', question: expect.stringMatching(/power.up[\s\S]*ADA[\s\S]*firmware version/i) },
    ]);
    const report = await readReport();
    expect(report.firmware).toEqual({ entered: '2.01', version: '2.01', level: 2 });
  });

  it.each([
    ['138', '1.38'],
    ['v1.38', '1.38'],
    ['not sure', undefined],
  ])('warns when the firmware entered as "%s" is not v2.x, and still runs the probes', async (entered, version) => {
    const operator = new ScriptedOperator([entered]);
    const port = new ScriptedPort([{ expect: REQUEST_WORKING_REGISTER_CH3, reply: [WORKING_REGISTER_REPLY_CH3] }]);

    await runSession({ port, operator, connection: CONNECTION, timeoutMs: 50, probes: [connectivityProbe], sessionDir });

    const warning = operator.events.find((event) => event.kind === 'warn');
    expect(warning).toMatchObject({ message: expect.stringMatching(/not v2\.x/) });
    expect(warning).toMatchObject({ message: expect.stringMatching(/writing .*Memories may be unsafe/) });
    const report = await readReport();
    expect(report.firmware.entered).toBe(entered);
    expect(report.firmware.version).toBe(version);
    expect(report.firmware.warning).toMatch(/not v2\.x/);
    expect(port.sent).toEqual([REQUEST_WORKING_REGISTER_CH3]);
  });

  it('writes every message sent and received to the capture log with a timestamp and its bytes', async () => {
    const port = new ScriptedPort([
      { expect: PING, reply: [] },
      { expect: REQUEST_WORKING_REGISTER_CH3, reply: [WORKING_REGISTER_REPLY_CH3] },
    ]);

    await runSession({
      port,
      operator: new ScriptedOperator(['2.01']),
      connection: CONNECTION,
      timeoutMs: 20,
      probes: [pingProbe, connectivityProbe],
      sessionDir,
    });

    const log = await readFile(join(sessionDir, 'capture.log'), 'utf8');
    const iso = String.raw`\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z`;
    const lines = log.split('\n').filter((line) => new RegExp(`^${iso} +(sent|received)`).test(line));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(new RegExp(`^${iso} +sent +6 bytes +F0 7E 7F 06 01 F7$`));
    expect(lines[1]).toMatch(new RegExp(`^${iso} +sent +7 bytes +F0 0D 02 08 01 68 F7$`));
    expect(lines[2]).toMatch(
      new RegExp(`^${iso} +received +19 bytes +F0 0D 02 09 01 7F 0A 14 10 03 04 05 06 01 32 19 02 5A F7$`),
    );
    // Each probe's traffic sits under its own heading.
    expect(log.indexOf('probe ping')).toBeLessThan(log.indexOf(lines[0]!));
    expect(log.indexOf('probe connectivity')).toBeGreaterThan(log.indexOf(lines[0]!));
    expect(log.indexOf('probe connectivity')).toBeLessThan(log.indexOf(lines[1]!));
  });

  it("writes a machine-readable report with every probe's verdict and evidence", async () => {
    const port = new ScriptedPort([
      { expect: PING, reply: [] },
      { expect: REQUEST_WORKING_REGISTER_CH3, reply: [WORKING_REGISTER_REPLY_CH3] },
    ]);

    const returned = await runSession({
      port,
      operator: new ScriptedOperator(['201']),
      connection: CONNECTION,
      timeoutMs: 20,
      probes: [pingProbe, connectivityProbe],
      sessionDir,
    });

    const report = await readReport();
    expect(report).toEqual(returned);
    expect(report.firmware).toEqual({ entered: '201', version: '2.01', level: 2 });
    expect(report.connection).toEqual(CONNECTION);
    expect(report.timeoutMs).toBe(20);
    expect(report.startedAt).toMatch(/^\d{4}-/);
    expect(report.finishedAt).toMatch(/^\d{4}-/);
    expect(report.probes.map(({ probe, kind, verdict }) => ({ probe, kind, verdict }))).toEqual([
      { probe: 'ping', kind: 'non-destructive', verdict: 'inconclusive' },
      { probe: 'connectivity', kind: 'non-destructive', verdict: 'confirmed' },
    ]);
    const connectivity = report.probes[1]!;
    expect(connectivity.summary).toMatch(/valid Program/);
    expect(connectivity.findings.join('\n')).toMatch(/checksum matches/);
    expect(connectivity.data).toContainEqual({ name: 'Master Gain', raw: 16 });
    expect(connectivity.traffic).toEqual([
      { direction: 'sent', bytes: 'F0 0D 02 08 01 68 F7', time: expect.stringMatching(/Z$/) },
      {
        direction: 'received',
        bytes: 'F0 0D 02 09 01 7F 0A 14 10 03 04 05 06 01 32 19 02 5A F7',
        time: expect.stringMatching(/Z$/),
      },
    ]);
  });
});

describe('choosing which probes run', () => {
  it('picks a single probe by name', () => {
    expect(selectProbes(REGISTRY, 'memory-write')).toEqual([memoryWritingProbe]);
  });

  it('runs only the probes that declare themselves non-destructive for "all non-destructive"', () => {
    expect(selectProbes(REGISTRY, { allNonDestructive: true })).toEqual([connectivityProbe, pingProbe]);
  });

  it('names the known probes when asked for an unknown one', () => {
    expect(() => selectProbes(REGISTRY, 'nope')).toThrow(/Unknown probe "nope".*connectivity, memory-write, ping, guided/);
  });
});
