/**
 * Minimal `.env.local` / `.env` loader for the CLI, the MCP server and the live tests. No
 * dependency on dotenv (workspace rule: no new deps). Values are never logged.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Directories examined: the start directory plus at most this many ancestors. */
const MAX_UPWARD_STEPS = 6;
const CANDIDATE_NAMES = ['.env.local', '.env'] as const;

/**
 * Walks up from `startDir` (≤ 6 steps) looking for `.env.local`, then `.env`, in each directory.
 * The first file found is parsed (`KEY=value` lines; `#` comments, blank lines and an optional
 * `export ` prefix are ignored; keys and values are trimmed; one pair of matching quotes is
 * stripped). Each key is set on `process.env` only when it is not already set. Returns the path of
 * the file loaded, or `undefined` when none was found.
 */
export function loadEnvLocal(startDir: string = process.cwd()): string | undefined {
  let dir = resolve(startDir);
  for (let step = 0; step <= MAX_UPWARD_STEPS; step++) {
    for (const name of CANDIDATE_NAMES) {
      const file = join(dir, name);
      if (existsSync(file)) {
        applyEnv(parseEnv(readFileSync(file, 'utf8')));
        return file;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function applyEnv(pairs: ReadonlyMap<string, string>): void {
  for (const [key, value] of pairs) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Parses dotenv-style text into key/value pairs. Exported for tests only. */
export function parseEnv(text: string): Map<string, string> {
  const pairs = new Map<string, string>();
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (const rawLine of source.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) continue;
    pairs.set(key, unquote(line.slice(eq + 1).trim()));
  }
  return pairs;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'" || first === '`') && first === last) {
      return value.slice(1, -1);
    }
  }
  // Unquoted values may carry a trailing comment (` # …`), as in dotenv.
  const comment = value.search(/\s#/);
  return comment >= 0 ? value.slice(0, comment).trim() : value;
}
