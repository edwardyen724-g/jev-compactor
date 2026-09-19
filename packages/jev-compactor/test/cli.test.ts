/**
 * The `jev-compactor` bin, offline: every spawn runs without TYPESAFE_API_KEY and from a directory
 * outside the repo, so the SDK throws before any request and the run fails open — the tests assert
 * `report.skipped === 'jev_unavailable'` as proof no network was touched. The `inspect` view is also
 * exercised in-process on an inline `CompactionResult`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { groupUnits, normalize } from '../src/normalize.js';
import { redactReport, redactResult, renderInspect, summaryLine } from '../src/render.js';
import type { AnyMessage, CompactionReport, CompactionResult } from '../src/types.js';
import { CLI_BIN, ensureBuilt, fixture, GOAL, offlineEnv, PACKAGE_DIR } from './bin.helpers.js';

const ESC = String.fromCharCode(27);
/** `ESC[<code>m`: the SGR sequence util.styleText emits. */
const sgr = (code: number): string => `${ESC}[${code}m`;
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`);
const ANSI_ALL = new RegExp(ANSI.source, 'g');
const UNIT_LINE = /^(KEEP|PIN|FLAG|DUP|DROP|TRUNC)\b/;

let workDir: string;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], extra: { input?: string; env?: NodeJS.ProcessEnv } = {}): Run {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: workDir,
    env: { ...offlineEnv(), ...(extra.env ?? {}) },
    encoding: 'utf8',
    ...(extra.input === undefined ? {} : { input: extra.input }),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Like `cli`, but without blocking the event loop, for a test that also serves HTTP from this process. */
function cliAsync(args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd: workDir,
      env: { ...offlineEnv(), ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function loadFixture(name: string): AnyMessage[] {
  return JSON.parse(readFileSync(fixture(name), 'utf8')) as AnyMessage[];
}

function unitCount(messages: AnyMessage[]): number {
  return groupUnits(normalize(messages, 'auto').frames).length;
}

function unitLines(text: string): string[] {
  return text.split('\n').filter((line) => UNIT_LINE.test(line));
}

/** A fixture cut right after its `rm -rf ./src` proposal, written to the work dir: the proposal is the pending action. */
function proposalFile(name: string): string {
  const messages = loadFixture(name);
  const rm = messages.findIndex((m) => JSON.stringify(m).includes('rm -rf ./src'));
  const path = join(workDir, `proposal-${name}`);
  writeFileSync(path, JSON.stringify(messages.slice(0, rm + 1)));
  return path;
}

beforeAll(async () => {
  await ensureBuilt();
  workDir = mkdtempSync(join(tmpdir(), 'jev-compactor-cli-'));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ───────────────────────────── errors and usage ─────────────────────────────

describe('cli errors', () => {
  it('exits 1 with a message when the file is missing', () => {
    const missing = join(workDir, 'does-not-exist.json');
    const run = cli(['compact', missing]);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/^jev-compactor: cannot read /);
    expect(run.stderr).toContain('does-not-exist.json');
  });

  it('exits 1 with usage when there is no command, an unknown command, or no file', () => {
    for (const args of [[], ['frobnicate', 'x.json'], ['compact']]) {
      const run = cli(args);
      expect(run.status, args.join(' ')).toBe(1);
      expect(run.stderr).toMatch(/^jev-compactor: /);
      expect(run.stderr).toContain('Usage:');
    }
  });

  it('exits 1 on an unknown flag, a bad --max-tokens, a bad --format, and non-message JSON', () => {
    const plain = fixture('plain-chat.json');
    expect(cli(['compact', plain, '--bogus']).status).toBe(1);
    expect(cli(['compact', plain, '--max-tokens', 'abc']).stderr).toMatch(/--max-tokens expects/);
    expect(cli(['compact', plain, '--max-tokens', '0']).status).toBe(1);
    expect(cli(['compact', plain, '--format', 'nope']).stderr).toMatch(/--format expects/);
    const notMessages = cli(['compact', '-'], { input: '{"foo": 1}' });
    expect(notMessages.status).toBe(1);
    expect(notMessages.stderr).toMatch(/expected a JSON array of messages/);
    const notObjects = cli(['compact', '-'], { input: '[1, 2]' });
    expect(notObjects.status).toBe(1);
    expect(notObjects.stderr).toMatch(/messages\[0\] is not an object/);
    const invalid = cli(['compact', '-'], { input: '{not json' });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toMatch(/invalid JSON/);
  });

  it('prints help and the package version', () => {
    const help = cli(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage:');
    const { version } = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as {
      version: string;
    };
    const ver = cli(['--version']);
    expect(ver.status).toBe(0);
    expect(ver.stdout.trim()).toBe(version);
  });
});

// ───────────────────────────── compact ─────────────────────────────

describe('cli compact (offline)', () => {
  it('--json prints a CompactionResult that parses, failed open without a key', () => {
    const messages = loadFixture('plain-chat.json');
    const run = cli(['compact', fixture('plain-chat.json'), '--json']);
    expect(run.status).toBe(0);
    const result = JSON.parse(run.stdout) as CompactionResult;
    expect(result.report.skipped).toBe('jev_unavailable');
    expect(result.report.error).toMatch(/API key/);
    expect(result.compacted).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(result.report.messagesBefore).toBe(messages.length);
    expect(result.report.units.length).toBe(unitCount(messages));
    // The summary, then why the run failed open, so a no-op never passes for success.
    expect(run.stderr).toMatch(
      /^kept 33\/33 messages · [\d,]+ → [\d,]+ tokens · skipped: jev_unavailable\njev-compactor: jev unavailable: .*API key/,
    );
  });

  it('scrubs the API key from report.error, even when a gateway echoes the request headers', async () => {
    const fakeKey = `sk-test-${'k'.repeat(24)}`;
    const server = createServer((req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          detail: {
            message: `request rejected by gateway; headers=${JSON.stringify(req.headers)}`,
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const env = { TYPESAFE_API_KEY: fakeKey, TYPESAFE_BASE_URL: `http://127.0.0.1:${port}` };
      const run = await cliAsync(['compact', fixture('plain-chat.json'), '--json'], env);
      expect(run.status).toBe(0);
      const result = JSON.parse(run.stdout) as CompactionResult;
      expect(result.report.skipped).toBe('jev_unavailable');
      expect(result.report.error).toContain('rejected by gateway');
      expect(result.report.error).toContain('[redacted]');
      expect(run.stdout).not.toContain(fakeKey);
      expect(run.stderr).toContain('[redacted]');
      expect(run.stderr).not.toContain(fakeKey);
    } finally {
      server.close();
    }
  });

  it('writes the message array to stdout, or to --out, with the summary on stderr', () => {
    const messages = loadFixture('plain-chat.json');
    const toStdout = cli(['compact', fixture('plain-chat.json')]);
    expect(toStdout.status).toBe(0);
    expect(JSON.parse(toStdout.stdout)).toEqual(messages);
    expect(toStdout.stdout.endsWith('\n')).toBe(true);
    expect(toStdout.stderr).toMatch(/^kept 33\/33 messages/);

    const out = join(workDir, 'compacted.json');
    const toFile = cli(['compact', fixture('plain-chat.json'), '--out', out]);
    expect(toFile.status).toBe(0);
    expect(toFile.stdout).toBe('');
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(messages);
    expect(toFile.stderr).toMatch(/^kept 33\/33 messages/);
  });

  it('reads stdin for "-" and accepts {messages: [...]}', () => {
    const messages = loadFixture('plain-chat.json');
    const run = cli(['compact', '-'], { input: JSON.stringify({ messages }) });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(messages);
  });

  it('honors --goal, --max-tokens and --format in the report', () => {
    const run = cli([
      'compact',
      fixture('plain-chat.json'),
      '--json',
      '--goal',
      'ship it',
      '--max-tokens',
      '500',
      '--format',
      'plain',
    ]);
    expect(run.status).toBe(0);
    const result = JSON.parse(run.stdout) as CompactionResult;
    expect(result.report.goal).toBe('ship it');
    expect(result.report.format).toBe('plain');
  });

  it('exits 2 with --safety when the pending rm -rf proposal is blocked by the regex floor', () => {
    const run = cli([
      'compact',
      proposalFile('openai-tool-loop.json'),
      '--safety',
      '--goal',
      GOAL,
      '--json',
    ]);
    expect(run.status).toBe(2);
    const result = JSON.parse(run.stdout) as CompactionResult;
    expect(result.blocked).toBe(true);
    expect(result.report.skipped).toBe('jev_unavailable');
    const hit = result.report.foreman.find(
      (f) => f.source === 'pattern' && f.kind === 'destructive',
    );
    expect(hit).toBeDefined();
    expect(hit?.level).toBe('action');
    expect(hit?.evidence).toContain('rm -rf ./src');
    expect(run.stderr).toContain('BLOCKED');

    // Without --safety the same run is not blocked.
    const open = cli(['compact', proposalFile('openai-tool-loop.json'), '--goal', GOAL, '--json']);
    expect(open.status).toBe(0);
    expect((JSON.parse(open.stdout) as CompactionResult).blocked).toBe(false);

    // The full fixture moved past the proposal (the user rejected it): reported and flagged, exit 0.
    const past = cli([
      'compact',
      fixture('openai-tool-loop.json'),
      '--safety',
      '--goal',
      GOAL,
      '--json',
    ]);
    expect(past.status).toBe(0);
    const pastResult = JSON.parse(past.stdout) as CompactionResult;
    expect(pastResult.blocked).toBe(false);
    expect(pastResult.report.foreman.some((f) => f.source === 'pattern')).toBe(true);
  });
});

// ───────────────────────────── inspect ─────────────────────────────

describe('cli inspect (offline)', () => {
  it('prints one line per unit, with FLAG on the rm -rf unit and PIN on the system prompt', () => {
    const messages = loadFixture('openai-tool-loop.json');
    const run = cli(['inspect', fixture('openai-tool-loop.json'), '--goal', GOAL]);
    expect(run.status).toBe(0);
    const lines = unitLines(run.stdout);
    expect(lines).toHaveLength(unitCount(messages));
    expect(run.stdout).not.toMatch(ANSI);
    expect(run.stdout).toMatch(/^goal {5}Fix the failing unit test in src\/auth\.ts$/m);
    expect(run.stdout).toMatch(/^format {3}openai · 35 messages · \d+ units$/m);
    expect(run.stdout).toMatch(/^result {3}kept 35\/35 messages/m);

    const rmIndex = messages.findIndex((m) => JSON.stringify(m).includes('rm -rf ./src'));
    const flag = lines.find((line) => line.startsWith('FLAG') && line.includes('rm -rf ./src'));
    expect(flag).toBeDefined();
    expect(flag).toContain(`#${rmIndex}`);
    expect(lines[0]).toMatch(/^PIN +u0 +#0 +system +[\d,]+ tok +pinned:system/);
    expect(lines.some((line) => line.startsWith('PIN') && line.includes('pinned:goal-path'))).toBe(
      true,
    );
    expect(run.stdout).toMatch(/^foreman\n {2}action +destructive +pattern +p=1\.00 +#\d+/m);
    expect(run.stdout).not.toContain('corrective');
    expect(run.stderr).toBe('');
  });

  it('exits 2 with --safety when blocked, still printing the view', () => {
    const run = cli([
      'inspect',
      proposalFile('anthropic-tool-loop.json'),
      '--safety',
      '--goal',
      GOAL,
    ]);
    expect(run.status).toBe(2);
    expect(run.stdout).toContain('blocked  yes (safety gating)');
    const messages = JSON.parse(
      readFileSync(proposalFile('anthropic-tool-loop.json'), 'utf8'),
    ) as AnyMessage[];
    expect(unitLines(run.stdout).length).toBe(unitCount(messages));
  });

  it('colors with FORCE_COLOR, not with NO_COLOR, and never into --out', () => {
    const forced = cli(['inspect', fixture('plain-chat.json')], { env: { FORCE_COLOR: '1' } });
    expect(forced.status).toBe(0);
    expect(forced.stdout).toMatch(ANSI);
    const plain = cli(['inspect', fixture('plain-chat.json')], {
      env: { FORCE_COLOR: '1', NO_COLOR: '1' },
    });
    // FORCE_COLOR wins over NO_COLOR, as in Node itself.
    expect(plain.stdout).toMatch(ANSI);
    const noColor = cli(['inspect', fixture('plain-chat.json')], { env: { NO_COLOR: '1' } });
    expect(noColor.stdout).not.toMatch(ANSI);

    const out = join(workDir, 'inspect.txt');
    const toFile = cli(['inspect', fixture('plain-chat.json'), '--out', out], {
      env: { FORCE_COLOR: '1' },
    });
    expect(toFile.status).toBe(0);
    expect(toFile.stdout).toBe('');
    expect(readFileSync(out, 'utf8')).not.toMatch(ANSI);
    expect(toFile.stderr).toMatch(/^kept 33\/33 messages/);
  });

  it('--json prints the CompactionResult for inspect too', () => {
    const run = cli(['inspect', fixture('langchain.json'), '--json']);
    expect(run.status).toBe(0);
    const result = JSON.parse(run.stdout) as CompactionResult;
    expect(result.report.format).toBe('langchain');
    expect(result.report.units.length).toBe(unitCount(loadFixture('langchain.json')));
  });
});

// ───────────────────────────── renderInspect (pure) ─────────────────────────────

describe('renderInspect', () => {
  const messages: AnyMessage[] = [
    { role: 'system', content: 'You are terse.' },
    { role: 'user', content: 'Fix src/auth.ts' },
    { role: 'assistant', content: 'Nice weather today, by the way.' },
    { role: 'assistant', content: 'Nice weather today, by the way.' },
    { role: 'assistant', content: 'I will run rm -rf ./src now.' },
    { role: 'user', content: 'No. Read src/auth.ts first.' },
  ];
  const corrective = {
    role: 'system',
    content: 'Compaction notice: drifted from "Fix src/auth.ts".',
  };
  const result: CompactionResult = {
    messages: [messages[0], messages[1], messages[4], messages[5], corrective] as AnyMessage[],
    report: {
      goal: 'Fix src/auth.ts',
      format: 'plain',
      tokensBefore: 120,
      tokensAfter: 90,
      messagesBefore: 6,
      messagesAfter: 5,
      units: [
        { unit: 'u0', indices: [0], decision: 'pinned', reason: 'pinned:system', tokens: 20 },
        {
          unit: 'u1',
          indices: [1],
          decision: 'pinned',
          reason: 'pinned:goal-path src/auth.ts',
          tokens: 20,
        },
        { unit: 'u2', indices: [2], decision: 'duplicate', reason: 'duplicate of u3', tokens: 25 },
        {
          unit: 'u3',
          indices: [3],
          decision: 'dropped',
          pKeep: 0.07,
          confidence: 0.9,
          reason: 'jev:drop p=0.93',
          tokens: 25,
        },
        {
          unit: 'u4',
          indices: [4],
          decision: 'flagged',
          pKeep: 0.8,
          reason: 'flagged:destructive rm-recursive: rm -rf ./src (was jev:keep p=0.80)',
          tokens: 15,
        },
        {
          unit: 'u5',
          indices: [5],
          decision: 'budget',
          pKeep: 0.6,
          confidence: 0.5,
          reason: 'budget',
          tokens: 15,
        },
      ],
      foreman: [
        {
          kind: 'destructive',
          source: 'pattern',
          probability: 1,
          level: 'action',
          indices: [4],
          evidence: 'rm-recursive: rm -rf ./src',
        },
        { kind: 'goal_drift', source: 'jev', probability: 0.81, level: 'action', indices: [] },
        { kind: 'thrashing', source: 'jev', probability: 0.4, level: 'review', indices: [] },
      ],
      progress: 1,
      jev: {
        model: 'jev-1.13.0',
        requests: 1,
        inputTokens: 1000,
        outputTokens: 0,
        latencyMs: 418,
        requestIds: ['r1'],
        estimatedUsd: 0.000042,
        stateTokens: 900,
        fitStage: 0,
        unjudged: 0,
      },
      latencyMs: 500,
    },
    blocked: false,
    compacted: true,
  };

  it('renders one tagged line per unit, the findings and the corrective prompt, plain by default', () => {
    const text = renderInspect(result, messages);
    expect(text).not.toMatch(ANSI);
    const lines = unitLines(text);
    expect(lines.map((l) => l.split(/\s+/)[0])).toEqual([
      'PIN',
      'PIN',
      'DUP',
      'DROP',
      'FLAG',
      'DROP',
    ]);
    expect(lines[3]).toContain('jev:drop p=0.93');
    expect(lines[3]).toContain('Nice weather today');
    expect(lines[5]).toContain('budget p=0.40'); // P(drop) added when the reason lacks it
    expect(lines[4]).toMatch(/^FLAG +u4 +#4 +assistant +15 tok +flagged:destructive/);
    expect(text).toContain('result   kept 5/6 messages · 120 → 90 tokens · jev 418 ms · $0.0000');
    expect(text).toMatch(
      /foreman\n {2}action +destructive +pattern +p=1\.00 +#4 +rm-recursive: rm -rf \.\/src\n {2}action +goal_drift +jev +p=0\.81\n {2}review +thrashing +jev +p=0\.40\n/,
    );
    expect(text).toMatch(
      /corrective\n {2}Compaction notice: drifted from "Fix src\/auth\.ts"\.\n$/,
    );
  });

  it('styles the tags and strikes dropped lines through when color is on', () => {
    const text = renderInspect(result, messages, { color: true });
    const lines = unitLines(text.replace(ANSI_ALL, ''));
    expect(lines).toHaveLength(6);
    const raw = text.split('\n');
    const drop = raw.find((l) => l.includes('jev:drop p=0.93'));
    // Dim + strikethrough over the whole line.
    expect(drop?.startsWith(`${sgr(2)}${sgr(9)}DROP`)).toBe(true);
    const keep = raw.find((l) => l.includes('pinned:system'));
    expect(keep?.startsWith(`${sgr(34)}PIN`)).toBe(true); // blue tag only
    expect(keep).not.toContain(sgr(9));
    const flag = raw.find((l) => l.includes('flagged:destructive'));
    expect(flag?.startsWith(`${sgr(31)}FLAG`)).toBe(true);
    expect(text).toContain(`${sgr(31)}  action  destructive`);
  });

  it('truncates the preview to the width and drops it when there is no room', () => {
    const wide = renderInspect(result, messages, { width: 200 });
    expect(wide).toContain('I will run rm -rf ./src now.');
    const narrow = renderInspect(result, messages, { width: 60 });
    const line = unitLines(narrow).find((l) => l.startsWith('DUP')) ?? '';
    expect(line.length).toBeLessThanOrEqual(60);
    expect(line.endsWith('…') || !line.includes('Nice')).toBe(true);
  });

  it('reports the anthropic addendum, a skipped run and a block', () => {
    const skipped: CompactionResult = {
      messages: [...messages],
      report: {
        ...result.report,
        units: [],
        foreman: [],
        skipped: 'jev_unavailable',
        error: 'No API key was provided.',
      },
      blocked: true,
      compacted: false,
      systemAddendum: 'Compaction notice: addendum.',
    };
    const text = renderInspect(skipped, messages);
    expect(text).toContain('error    No API key was provided.');
    expect(text).toContain('blocked  yes (safety gating)');
    expect(text).toContain('foreman  none');
    expect(text).toContain('corrective\n  Compaction notice: addendum.');
    expect(summaryLine(skipped)).toBe(
      'kept 5/6 messages · 120 → 90 tokens · jev 418 ms · $0.0000 · skipped: jev_unavailable · BLOCKED',
    );
  });
});

// ───────────────────────────── redaction (pure) ─────────────────────────────

describe('redaction', () => {
  const KEY = 'sk-unit-test-key-0123456789abcdef';
  function withKey<T>(fn: () => T): T {
    const previous = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = KEY;
    try {
      return fn();
    } finally {
      if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previous;
    }
  }
  const base: CompactionReport = {
    goal: '',
    format: 'plain',
    tokensBefore: 1,
    tokensAfter: 1,
    messagesBefore: 1,
    messagesAfter: 1,
    units: [{ unit: 'u0', indices: [0], decision: 'kept', reason: 'jev:unavailable', tokens: 1 }],
    foreman: [],
    latencyMs: 0,
  };

  it('redactReport / redactResult scrub the key from report.error and nothing else', () =>
    withKey(() => {
      const report: CompactionReport = { ...base, error: `401 bad token ${KEY} (gateway echo)` };
      const scrubbed = redactReport(report);
      expect(scrubbed.error).toBe('401 bad token [redacted] (gateway echo)');
      expect(scrubbed).not.toBe(report);
      expect(report.error).toContain(KEY); // the caller's report is untouched
      expect(redactReport(base)).toBe(base); // nothing to scrub: the same object
      const messages: AnyMessage[] = [{ role: 'user', content: 'x' }];
      const result = redactResult({ messages, report, blocked: false, compacted: false });
      expect(result.messages).toBe(messages);
      expect(result.report.error).toBe('401 bad token [redacted] (gateway echo)');
    }));

  it('renderInspect scrubs the key from unit previews', () =>
    withKey(() => {
      const leaky: AnyMessage[] = [
        { role: 'user', content: `cat .env printed TYPESAFE_API_KEY=${KEY} here` },
      ];
      const result: CompactionResult = {
        messages: leaky,
        report: base,
        blocked: false,
        compacted: false,
      };
      const text = renderInspect(result, leaky, { width: 200 });
      expect(text).toContain('TYPESAFE_API_KEY=[redacted]');
      expect(text).not.toContain(KEY);
    }));
});
