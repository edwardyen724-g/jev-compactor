/**
 * Live Jev round trip — no mocks (workspace rule). Skipped loudly without TYPESAFE_API_KEY.
 * Cost: one fixture-sized request (~$0.0005) plus a rejected oversize request.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadEnvLocal } from '../src/env.js';
import { askJev, createClient, StateTooLargeError } from '../src/jev.js';
import { defaultGoal, groupUnits, normalize } from '../src/normalize.js';
import { estimateTokens } from '../src/tokens.js';
import type { Unit } from '../src/types.js';
import { hugeSkeleton, inlineSkeleton, loadFixture, resolvedOptions } from './jev.helpers.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
loadEnvLocal(REPO_ROOT);

const HAS_KEY = Boolean(process.env.TYPESAFE_API_KEY);
if (!HAS_KEY) console.warn('TYPESAFE_API_KEY not set — live tests skipped');

/**
 * Measured 2026-09-18 against jev-latest: the helper's repetitive prose tokenizes at ≈5.7
 * chars/token, so 150k chars (≈26k tokens) is accepted, 200k (≈35k) is rejected and 300k (≈52k)
 * is still rejected with `max_tokens_exceeded`. 300k keeps a comfortable margin over the 32k limit.
 */
const HUGE_STATE_CHARS = 300_000;

describe.skipIf(!HAS_KEY)('askJev (live)', () => {
  const opts = resolvedOptions();
  // Built lazily so a skipped run never constructs a client (the SDK throws without a key).
  const client = (): ReturnType<typeof createClient> => createClient(opts);

  it('judges every candidate of the openai fixture and flags the rm -rf proposal', async () => {
    const messages = loadFixture('openai-tool-loop.json');
    const { frames } = normalize(messages, 'auto');
    const units = groupUnits(frames);
    const goal = defaultGoal(frames);
    expect(goal).toMatch(/src\/auth\.ts/);

    // Candidates: everything that is not a system unit and not among the last keepRecent units.
    const cutoff = units.length - opts.keepRecent;
    const candidates: Unit[] = units.filter(
      (u, i) => i < cutoff && !u.frames.some((f) => f.kind === 'system'),
    );
    expect(candidates.length).toBeGreaterThan(5);

    const skeleton = inlineSkeleton(units, goal, opts);
    expect(skeleton.tokens).toBeLessThanOrEqual(opts.stateTokens);
    expect(skeleton.tokens).toBe(estimateTokens(JSON.stringify(skeleton.state)));

    const answers = await askJev(skeleton, candidates, opts, client());

    expect(answers.units.size).toBe(candidates.length);
    for (const unit of candidates) {
      const judged = answers.units.get(unit.id);
      expect(judged, `no answer for ${unit.id}`).toBeDefined();
      expect(judged?.pKeep).toBeGreaterThanOrEqual(0);
      expect(judged?.pKeep).toBeLessThanOrEqual(1);
      expect(judged?.confidence).toBeGreaterThanOrEqual(0);
      expect(judged?.confidence).toBeLessThanOrEqual(1);
    }

    // The fixture's assistant proposes `rm -rf` (message 11).
    expect(answers.foreman.destructive).toBeGreaterThan(0.7);
    for (const p of Object.values(answers.foreman)) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
    expect(answers.progress).toBeDefined();
    expect(answers.progress).toBeGreaterThanOrEqual(0);
    expect(answers.progress).toBeLessThanOrEqual(2);

    // The pleasantry ("btw thanks … how's your day going?", message 8) is a clear drop.
    const pleasantry = candidates.find((u) => u.indices.includes(8));
    expect(pleasantry).toBeDefined();
    if (pleasantry !== undefined) {
      expect(answers.units.get(pleasantry.id)?.pKeep).toBeLessThan(0.5);
    }

    const t = answers.telemetry;
    expect(t.requests).toBeGreaterThanOrEqual(1);
    expect(t.inputTokens).toBeGreaterThan(0);
    expect(t.estimatedUsd).toBeGreaterThan(0);
    expect(t.estimatedUsd).toBeCloseTo((t.inputTokens * 0.042) / 1e6, 12);
    expect(t.latencyMs).toBeGreaterThanOrEqual(0);
    expect(t.model).toMatch(/^jev/);
    expect(t.requestIds.length).toBeLessThanOrEqual(t.requests);
    expect(t.stateTokens).toBe(skeleton.tokens);
    expect(t.fitStage).toBe(0);
    expect(t.unjudged).toBe(0);
  });

  it('throws StateTooLargeError for a state far over 32k tokens', async () => {
    const skeleton = { ...hugeSkeleton(HUGE_STATE_CHARS), fitStage: 2 };
    expect(skeleton.tokens).toBeGreaterThan(32_000);

    let caught: unknown;
    try {
      await askJev(skeleton, [], opts, client());
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StateTooLargeError);
    if (caught instanceof StateTooLargeError) {
      expect(caught.stage).toBe(2);
      expect(caught.cause).toBeDefined();
      expect(caught.message).toMatch(/too large/);
      expect(caught.requests).toBe(1); // the rejected request is counted for telemetry
    }
  });
});
