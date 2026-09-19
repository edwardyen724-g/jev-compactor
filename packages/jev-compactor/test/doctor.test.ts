/** `jev-compactor doctor`, offline: without a key the first check fails and the exit code is 1. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_BIN, ensureBuilt, offlineEnv } from './bin.helpers.js';

let workDir: string;

beforeAll(async () => {
  await ensureBuilt();
  workDir = mkdtempSync(join(tmpdir(), 'jev-doctor-'));
}, 120_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('doctor (offline)', () => {
  it('fails the key check first, exits 1, and never contacts the API', () => {
    const run = spawnSync(process.execPath, [CLI_BIN, 'doctor'], {
      cwd: workDir,
      env: offlineEnv(),
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    const lines = run.stdout.trim().split('\n');
    expect(lines[0]).toMatch(/^✗ API key\s+TYPESAFE_API_KEY is not set/);
    expect(run.stdout).not.toContain('Jev API');
    expect(lines.at(-1)).toMatch(/Fix the ✗ line/);
  });

  it('rejects a stray argument', () => {
    const run = spawnSync(process.execPath, [CLI_BIN, 'doctor', 'extra'], {
      cwd: workDir,
      env: offlineEnv(),
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("unexpected argument 'extra'");
  });
});
