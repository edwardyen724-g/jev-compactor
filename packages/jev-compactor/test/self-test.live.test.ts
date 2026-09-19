/** `selfTest()` against the real Jev API: the happy path and the two failure stages it can name. */
import { describe, expect, it } from 'vitest';
import { selfTest } from '../src/engine.js';
import { loadEnvLocal } from '../src/env.js';
import { REPO_ROOT } from './bin.helpers.js';

loadEnvLocal(REPO_ROOT);
const key = process.env.TYPESAFE_API_KEY;
if (key === undefined) console.warn('TYPESAFE_API_KEY not set — live tests skipped');

describe.skipIf(key === undefined)('selfTest (live)', () => {
  it('compacts the built-in history and sees the rm -rf flagged by the regex floor and by Jev', async () => {
    const result = await selfTest();
    expect(result.ok).toBe(true);
    expect(result.stage).toBe('ok');
    expect(result.destructiveFlagged).toEqual({ pattern: true, jev: true });
    expect(result.messagesAfter).toBeLessThan(result.messagesBefore);
    expect(result.model).toMatch(/jev/);
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.requestIds?.length).toBeGreaterThan(0);
  });

  it('names the key stage when no key is available', async () => {
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      const result = await selfTest();
      expect(result.ok).toBe(false);
      expect(result.stage).toBe('key');
      expect(result.destructiveFlagged.pattern).toBe(true); // the regex floor still ran
    } finally {
      process.env.TYPESAFE_API_KEY = saved;
    }
  });

  it('names the jev stage when the key is rejected, without leaking it', async () => {
    const result = await selfTest({ apiKey: 'not-a-real-key-000000000000' });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('jev');
    expect(result.error).toBeDefined();
    expect(result.error).not.toContain(key);
  });
});
