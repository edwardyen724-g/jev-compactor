/** `jev-compactor doctor` with a real key: three ✓ lines and exit 0. */
import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadEnvLocal } from '../src/env.js';
import { CLI_BIN, ensureBuilt, REPO_ROOT } from './bin.helpers.js';

loadEnvLocal(REPO_ROOT);
const key = process.env.TYPESAFE_API_KEY;
if (key === undefined) console.warn('TYPESAFE_API_KEY not set — live tests skipped');

beforeAll(async () => {
  await ensureBuilt();
}, 120_000);

describe.skipIf(key === undefined)('doctor (live)', () => {
  it('passes all three checks', () => {
    const run = spawnSync(process.execPath, [CLI_BIN, 'doctor'], {
      cwd: REPO_ROOT,
      env: { ...process.env, TYPESAFE_LOG_LEVEL: 'off' },
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    const lines = run.stdout.trim().split('\n');
    expect(lines[0]).toMatch(/^✓ API key\s+TYPESAFE_API_KEY read from /);
    expect(lines[1]).toMatch(/^✓ Jev API\s+reachable in \d+ ms · models: .*jev/);
    expect(lines[2]).toMatch(/^✓ Compaction\s+jev.* answered in \d+ ms · \d+ → \d+ messages/);
    expect(lines[3]).toMatch(/^All good/);
    expect(run.stdout).not.toContain(key as string);
  });
});
