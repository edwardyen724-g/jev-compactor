import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnvLocal, parseEnv } from '../src/env.js';

// Every variable this file writes carries a unique prefix so the tests never read, set or depend
// on the real TYPESAFE_API_KEY (or anything else already in the environment).
const PREFIX = `JEVC_ENV_TEST_${process.pid}_${Date.now().toString(36)}_`;
const key = (name: string): string => `${PREFIX}${name}`;

const tempDirs: string[] = [];
const setKeys = new Set<string>();

function makeTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jev-compactor-env-'));
  tempDirs.push(dir);
  return dir;
}

function writeEnv(dir: string, name: string, lines: string[]): string {
  const file = join(dir, name);
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

/** Records a key so afterEach can remove it from process.env. */
function track(...names: string[]): void {
  for (const n of names) setKeys.add(n);
}

afterEach(() => {
  for (const k of setKeys) delete process.env[k];
  setKeys.clear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseEnv', () => {
  it('parses KEY=value lines and ignores comments and blanks', () => {
    const pairs = parseEnv(
      ['# comment', '', 'A=1', '  B = two  ', 'export C=3', 'D=a=b', 'E='].join('\n'),
    );
    expect([...pairs.entries()]).toEqual([
      ['A', '1'],
      ['B', 'two'],
      ['C', '3'],
      ['D', 'a=b'],
      ['E', ''],
    ]);
  });

  it('strips one pair of matching quotes and keeps # inside quotes', () => {
    const pairs = parseEnv(
      [
        'Q1="double # not a comment"',
        "Q2='single'",
        'Q3="unbalanced',
        'Q4=plain # trailing comment',
      ].join('\n'),
    );
    expect(pairs.get('Q1')).toBe('double # not a comment');
    expect(pairs.get('Q2')).toBe('single');
    expect(pairs.get('Q3')).toBe('"unbalanced');
    expect(pairs.get('Q4')).toBe('plain');
  });

  it('skips malformed lines and handles CRLF and a BOM', () => {
    const bom = String.fromCharCode(0xfeff);
    const pairs = parseEnv(`${bom}A=1\r\nno-equals-here\r\n=novalue\r\nB=2\r\n`);
    expect([...pairs.keys()]).toEqual(['A', 'B']);
  });
});

describe('loadEnvLocal', () => {
  it('loads .env.local from the start directory and returns its path', () => {
    const dir = makeTemp();
    const file = writeEnv(dir, '.env.local', [
      '# local secrets for a test',
      `${key('ONE')}=alpha`,
      `${key('TWO')}="quoted value"`,
      `${key('THREE')}='  padded  '`,
      `export ${key('FOUR')}=exported`,
      `${key('FIVE')}=with=equals`,
    ]);
    track(key('ONE'), key('TWO'), key('THREE'), key('FOUR'), key('FIVE'));

    expect(loadEnvLocal(dir)).toBe(file);
    expect(process.env[key('ONE')]).toBe('alpha');
    expect(process.env[key('TWO')]).toBe('quoted value');
    expect(process.env[key('THREE')]).toBe('  padded  ');
    expect(process.env[key('FOUR')]).toBe('exported');
    expect(process.env[key('FIVE')]).toBe('with=equals');
  });

  it('never overwrites a variable that is already set', () => {
    const dir = makeTemp();
    writeEnv(dir, '.env.local', [`${key('PRESET')}=from-file`, `${key('FRESH')}=from-file`]);
    track(key('PRESET'), key('FRESH'));
    process.env[key('PRESET')] = 'from-process';

    loadEnvLocal(dir);
    expect(process.env[key('PRESET')]).toBe('from-process');
    expect(process.env[key('FRESH')]).toBe('from-file');
  });

  it('prefers .env.local over .env in the same directory', () => {
    const dir = makeTemp();
    const local = writeEnv(dir, '.env.local', [`${key('WHICH')}=local`]);
    writeEnv(dir, '.env', [`${key('WHICH')}=plain`, `${key('ONLY_IN_ENV')}=x`]);
    track(key('WHICH'), key('ONLY_IN_ENV'));

    expect(loadEnvLocal(dir)).toBe(local);
    expect(process.env[key('WHICH')]).toBe('local');
    // Only the first file found is loaded.
    expect(process.env[key('ONLY_IN_ENV')]).toBeUndefined();
  });

  it('falls back to .env when there is no .env.local', () => {
    const dir = makeTemp();
    const file = writeEnv(dir, '.env', [`${key('FALLBACK')}=yes`]);
    track(key('FALLBACK'));

    expect(loadEnvLocal(dir)).toBe(file);
    expect(process.env[key('FALLBACK')]).toBe('yes');
  });

  it('walks up to six directories and stops there', () => {
    const root = makeTemp();
    const file = writeEnv(root, '.env.local', [`${key('DEEP')}=found`]);
    track(key('DEEP'));
    const segments = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
    mkdirSync(join(root, ...segments), { recursive: true });

    // Seven levels below the file: out of reach, nothing is set.
    expect(loadEnvLocal(join(root, ...segments))).toBeUndefined();
    expect(process.env[key('DEEP')]).toBeUndefined();

    // Six levels below: found.
    expect(loadEnvLocal(join(root, ...segments.slice(0, 6)))).toBe(file);
    expect(process.env[key('DEEP')]).toBe('found');
  });

  it('takes the nearest file even when a farther directory has .env.local', () => {
    const root = makeTemp();
    writeEnv(root, '.env.local', [`${key('NEAR')}=far`]);
    const nested = join(root, 'pkg');
    mkdirSync(nested);
    const near = writeEnv(nested, '.env', [`${key('NEAR')}=near`]);
    track(key('NEAR'));

    expect(loadEnvLocal(nested)).toBe(near);
    expect(process.env[key('NEAR')]).toBe('near');
  });

  it('adds only the keys from the file and touches nothing else in process.env', () => {
    const dir = makeTemp();
    writeEnv(dir, '.env.local', [`${key('ONLY')}=1`]);
    track(key('ONLY'));
    const before = new Set(Object.keys(process.env));

    loadEnvLocal(dir);

    const added = Object.keys(process.env).filter((k) => !before.has(k));
    expect(added).toEqual([key('ONLY')]);
  });
});
