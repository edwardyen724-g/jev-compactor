/**
 * The `jev-compactor` bin against the real Jev — no mocks (workspace rule). Skipped loudly
 * without TYPESAFE_API_KEY. The bin loads the key itself from the repo's .env.local via
 * loadEnvLocal(); the tests never read or print it. Cost: four fixture-sized runs, ≈ $0.004.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadEnvLocal } from '../src/env.js';
import { groupUnits, normalize } from '../src/normalize.js';
import type { AnyMessage, CompactionResult } from '../src/types.js';
import { CLI_BIN, ensureBuilt, fixture, GOAL, PACKAGE_DIR, REPO_ROOT } from './bin.helpers.js';

loadEnvLocal(REPO_ROOT);

const HAS_KEY = Boolean(process.env.TYPESAFE_API_KEY);
if (!HAS_KEY) console.warn('TYPESAFE_API_KEY not set — live tests skipped');

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`);
const UNIT_LINE = /^(KEEP|PIN|FLAG|DUP|DROP|TRUNC)\b/;

function cli(
  args: string[],
  input?: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, FORCE_COLOR: '0' },
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function loadFixture(name: string): AnyMessage[] {
  return JSON.parse(readFileSync(fixture(name), 'utf8')) as AnyMessage[];
}

describe.skipIf(!HAS_KEY)('cli (live)', () => {
  beforeAll(async () => {
    await ensureBuilt();
  });

  it('inspect prints one line per unit with real decisions, no colors when piped', () => {
    const messages = loadFixture('openai-tool-loop.json');
    const run = cli(['inspect', 'fixtures/openai-tool-loop.json', '--goal', GOAL]);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).not.toMatch(ANSI);
    const lines = run.stdout.split('\n').filter((line) => UNIT_LINE.test(line));
    expect(lines).toHaveLength(groupUnits(normalize(messages, 'auto').frames).length);
    expect(run.stdout).toMatch(
      /^result {3}kept \d+\/35 messages · [\d,]+ → [\d,]+ tokens · jev [\d,]+ ms · \$\d\.\d{4}$/m,
    );
    // Jev judged: kept units carry p=, and the dedup + regex floor still show.
    expect(lines.some((l) => l.startsWith('KEEP') && /jev:keep p=\d\.\d\d/.test(l))).toBe(true);
    // Jev drops the pleasantries in this fixture at p ≥ 0.9; a struck-through line carries its p=.
    expect(lines.some((l) => l.startsWith('DROP') && /jev:drop p=\d\.\d\d/.test(l))).toBe(true);
    expect(lines.some((l) => l.startsWith('FLAG') && l.includes('rm -rf ./src'))).toBe(true);
    expect(run.stdout).toMatch(/^foreman\n {2}action +destructive +pattern/m);
    console.info(run.stdout.split('\n').slice(0, 3).join('\n'));
  });

  it('compact --json compacts the plain fixture and parses', () => {
    const messages = loadFixture('plain-chat.json');
    const run = cli(['compact', 'fixtures/plain-chat.json', '--json']);
    expect(run.status).toBe(0);
    const result = JSON.parse(run.stdout) as CompactionResult;
    expect(result.compacted).toBe(true);
    expect(result.report.skipped).toBeUndefined();
    expect(result.report.jev?.requests).toBeGreaterThanOrEqual(1);
    expect(result.report.tokensAfter).toBeLessThan(result.report.tokensBefore);
    expect(result.messages.length).toBeLessThan(messages.length);
    // Every kept message is byte-identical to an input (the process boundary loses identity).
    const inputs = new Set(messages.map((m) => JSON.stringify(m)));
    const extras = result.messages.filter((m) => !inputs.has(JSON.stringify(m)));
    expect(extras.length).toBeLessThanOrEqual(1);
    expect(run.stderr).toMatch(
      /^kept \d+\/33 messages · [\d,]+ → [\d,]+ tokens · jev [\d,]+ ms · \$\d\.\d{4}\n$/,
    );
  });

  it('compact writes only the kept message objects to stdout', () => {
    const run = cli([
      'compact',
      'fixtures/anthropic-tool-loop.json',
      '--goal',
      GOAL,
      '--max-tokens',
      '4000',
    ]);
    expect(run.status).toBe(0);
    const kept = JSON.parse(run.stdout) as AnyMessage[];
    const messages = loadFixture('anthropic-tool-loop.json');
    const inputs = new Set(messages.map((m) => JSON.stringify(m)));
    for (const m of kept) expect(inputs.has(JSON.stringify(m))).toBe(true); // anthropic: no addendum in the array
    expect(kept.length).toBeLessThan(messages.length);
  });

  it('exits 2 with --safety when the rm -rf proposal is the pending action, with Jev telemetry in the report', () => {
    const messages = loadFixture('langchain.json');
    const rm = messages.findIndex((m) => JSON.stringify(m).includes('rm -rf ./src'));
    const proposal = JSON.stringify(messages.slice(0, rm + 1));
    const run = cli(['compact', '-', '--goal', GOAL, '--safety', '--json'], proposal);
    expect(run.status).toBe(2);
    const result = JSON.parse(run.stdout) as CompactionResult;
    expect(result.blocked).toBe(true);
    expect(result.report.jev).toBeDefined();
    expect(
      result.report.foreman.some((f) => f.level === 'action' && f.kind === 'destructive'),
    ).toBe(true);
    expect(run.stderr).toContain('BLOCKED');
  });
});
