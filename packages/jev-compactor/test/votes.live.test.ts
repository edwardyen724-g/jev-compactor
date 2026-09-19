/** `votes: 3` against the real API: three requests per batch, answers still in range. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compact } from '../src/engine.js';
import { loadEnvLocal } from '../src/env.js';
import type { AnyMessage } from '../src/types.js';
import { fixture, GOAL, REPO_ROOT } from './bin.helpers.js';

loadEnvLocal(REPO_ROOT);
const key = process.env.TYPESAFE_API_KEY;
if (key === undefined) console.warn('TYPESAFE_API_KEY not set — live tests skipped');

describe.skipIf(key === undefined)('votes (live)', () => {
  it('asks every batch three times and averages', async () => {
    const messages: AnyMessage[] = JSON.parse(
      readFileSync(fixture('openai-tool-loop.json'), 'utf8'),
    );
    const result = await compact(messages, { goal: GOAL, maxTokens: 4_000, votes: 3 });
    expect(result.compacted).toBe(true);
    expect(result.report.jev?.requests).toBeGreaterThanOrEqual(3);
    expect((result.report.jev?.requests ?? 0) % 3).toBe(0);
    const judged = result.report.units.filter((u) => u.pKeep !== undefined);
    expect(judged.length).toBeGreaterThan(0);
    for (const u of judged) {
      expect(u.pKeep).toBeGreaterThanOrEqual(0);
      expect(u.pKeep).toBeLessThanOrEqual(1);
    }
    expect(result.report.jev?.unjudged).toBe(0);
  });
});
