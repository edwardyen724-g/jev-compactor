/**
 * Shared support for the bin tests (`cli.test.ts`, `cli.live.test.ts`, `mcp.live.test.ts`): paths,
 * a build step that runs `pnpm exec tsdown` once per stale `dist/` under a cross-process lock (the
 * three files build concurrently under vitest and tsdown cleans `dist/`), and an environment with
 * the API key removed so the offline tests provably never reach Jev. Not a test file — vitest only
 * collects `*.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = join(PACKAGE_DIR, '..', '..');
export const FIXTURES_DIR = join(PACKAGE_DIR, 'fixtures');
export const CLI_BIN = join(PACKAGE_DIR, 'dist', 'cli.mjs');
export const MCP_BIN = join(PACKAGE_DIR, 'dist', 'mcp.mjs');

export const GOAL = 'Fix the failing unit test in src/auth.ts';

export function fixture(name: string): string {
  return join(FIXTURES_DIR, name);
}

/** `process.env` without the API key: the SDK then throws before any request is made. */
export function offlineEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  delete env.TYPESAFE_BASE_URL;
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return env;
}

// ───────────────────────────── build ─────────────────────────────

const SOURCES = [
  join(PACKAGE_DIR, 'src'),
  join(PACKAGE_DIR, 'package.json'),
  join(PACKAGE_DIR, 'tsdown.config.ts'),
];
const LOCK_STALE_MS = 120_000;
const LOCK_DIR = join(
  tmpdir(),
  `jev-compactor-build-${createHash('sha1').update(PACKAGE_DIR).digest('hex').slice(0, 12)}.lock`,
);

function newestMtime(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return Math.max(0, ...readdirSync(path).map((entry) => newestMtime(join(path, entry))));
}

function distIsFresh(): boolean {
  if (!existsSync(CLI_BIN) || !existsSync(MCP_BIN)) return false;
  const built = Math.min(statSync(CLI_BIN).mtimeMs, statSync(MCP_BIN).mtimeMs);
  return SOURCES.every((source) => !existsSync(source) || newestMtime(source) <= built);
}

async function acquireLock(): Promise<void> {
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      return;
    } catch (error: unknown) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw error;
      let age = 0;
      try {
        age = Date.now() - statSync(LOCK_DIR).mtimeMs;
      } catch {
        continue; // Released between the mkdir and the stat; try again.
      }
      if (age > LOCK_STALE_MS) rmSync(LOCK_DIR, { recursive: true, force: true });
      else await sleep(200);
    }
  }
}

/** Builds `dist/` with tsdown unless it is newer than every source, serialized across processes. */
export async function ensureBuilt(): Promise<void> {
  await acquireLock();
  try {
    if (distIsFresh()) return;
    execFileSync('pnpm', ['exec', 'tsdown'], {
      cwd: PACKAGE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!existsSync(CLI_BIN) || !existsSync(MCP_BIN)) {
      throw new Error(`tsdown finished but ${CLI_BIN} or ${MCP_BIN} is missing`);
    }
  } finally {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}
