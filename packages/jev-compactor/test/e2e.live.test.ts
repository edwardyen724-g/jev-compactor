/**
 * End to end through the public API — `../src/index.js`, the module `dist/index.mjs` is built
 * from — against the real Jev, no mocks (workspace rule). Every fixture is compacted once and the
 * six invariants from CLAUDE.md are asserted on the result:
 *   1. Jev never breaks a tool_call/tool_result pair (units are kept or dropped whole);
 *   2. a system message is never dropped;
 *   3. every kept message is the caller's object (`===`), in the original order, unmodified;
 *   4. every drop is attributable: a reason, and Jev's pKeep when Jev judged the unit;
 *   5. a bad key fails open: the input comes back unchanged with `skipped: 'jev_unavailable'`;
 *   6. `tokensAfter ≤ maxTokens`, or the report explains the overshoot (pins + minKeep, or the
 *      appended corrective prompt).
 * Skipped loudly without TYPESAFE_API_KEY. Cost: one compaction per fixture plus two small extra
 * runs, ≈ $0.002; the bad-key requests are rejected with 401 and cost nothing.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type AnyMessage,
  type CompactionReport,
  type CompactionResult,
  CompactionUnavailableError,
  type CompactOptions,
  compact,
  type Decision,
  groupUnits,
  loadEnvLocal,
  messagesTokens,
  normalize,
  type PrepassResult,
  prepass,
  resolveOptions,
  type Unit,
  withCompaction,
} from '../src/index.js';
import { loadFixture } from './jev.helpers.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
loadEnvLocal(REPO_ROOT);

const HAS_KEY = Boolean(process.env.TYPESAFE_API_KEY);
if (!HAS_KEY) console.warn('TYPESAFE_API_KEY not set — live tests skipped');

const GOAL = 'Fix the failing unit test in src/auth.ts';
const MAX_TOKENS = 4_000;
/** Rejected with 401 before any judging happens; never a real key. */
const BAD_KEY = 'jev-compactor-e2e-invalid-key';

const FIXTURES = [
  'openai-tool-loop.json',
  'anthropic-tool-loop.json',
  'langchain.json',
  'plain-chat.json',
] as const;
type FixtureName = (typeof FIXTURES)[number];

// ───────────────────────────── helpers ─────────────────────────────

function survives(decision: Decision): boolean {
  return decision === 'kept' || decision === 'pinned' || decision === 'flagged';
}

function isSystem(message: AnyMessage): boolean {
  return message.role === 'system' || message.type === 'system';
}

function expectProbability(value: number | undefined): void {
  expect(value).toBeDefined();
  expect(value).toBeGreaterThanOrEqual(0);
  expect(value).toBeLessThanOrEqual(1);
}

/** The pure front half of the pipeline, recomputed through the public API for cross-checks. */
interface Analysis {
  units: Unit[];
  pre: PrepassResult;
  minKeep: number;
}

function analyze(messages: AnyMessage[], options: CompactOptions): Analysis {
  const opts = resolveOptions(options, 'compact');
  const units = groupUnits(normalize(messages, opts.format).frames);
  return { units, pre: prepass(units, GOAL, opts), minKeep: opts.minKeep };
}

interface Run {
  messages: AnyMessage[];
  /** `JSON.stringify(messages)` taken before compaction: proves nothing was mutated. */
  snapshot: string;
  result: CompactionResult<AnyMessage>;
  analysis: Analysis;
  /** Result messages that are the caller's objects, in result order. */
  kept: AnyMessage[];
  /** Result messages that are not: at most the appended corrective system message. */
  extras: AnyMessage[];
}

async function runFixture(name: FixtureName): Promise<Run> {
  const messages = loadFixture(name);
  const snapshot = JSON.stringify(messages);
  const options: CompactOptions = { goal: GOAL, maxTokens: MAX_TOKENS };
  const result = await compact(messages, options);
  const inputSet = new Set<AnyMessage>(messages);
  return {
    messages,
    snapshot,
    result,
    analysis: analyze(messages, options),
    kept: result.messages.filter((m) => inputSet.has(m)),
    extras: result.messages.filter((m) => !inputSet.has(m)),
  };
}

// ───────────────────────────── tests ─────────────────────────────

describe.skipIf(!HAS_KEY)('e2e (live, public API)', () => {
  describe.each([...FIXTURES])('%s', (name) => {
    let run: Run;
    beforeAll(async () => {
      run = await runFixture(name);
    });

    it('compacts under the goal and reports Jev telemetry', () => {
      const { report } = run.result;
      expect(run.result.compacted).toBe(true);
      expect(report.skipped).toBeUndefined();
      expect(report.error).toBeUndefined();
      expect(report.goal).toBe(GOAL);
      expect(report.messagesBefore).toBe(run.messages.length);
      expect(report.messagesAfter).toBe(run.result.messages.length);
      expect(report.tokensBefore).toBe(messagesTokens(run.messages));
      expect(report.tokensAfter).toBeLessThan(report.tokensBefore);
      expect(report.units).toHaveLength(run.analysis.units.length);
      expect(report.jev?.requests).toBeGreaterThanOrEqual(1);
      expect(report.jev?.inputTokens).toBeGreaterThan(0);
      expect(report.jev?.estimatedUsd).toBeGreaterThan(0);
      expect(report.latencyMs).toBeGreaterThanOrEqual(report.jev?.latencyMs ?? 0);
    });

    it('1. never breaks a tool_call/tool_result pair', () => {
      const keptIndices = new Set(run.kept.map((m) => run.messages.indexOf(m)));
      // Units are kept or dropped whole …
      for (const unit of run.analysis.units) {
        const keptCount = unit.indices.filter((i) => keptIndices.has(i)).length;
        expect(
          keptCount === 0 || keptCount === unit.indices.length,
          `${unit.id} (messages ${unit.indices.join(',')}) was split: ${keptCount}/${unit.indices.length} kept`,
        ).toBe(true);
      }
      // … so every tool-call id issued in the output is answered in the output, and vice versa.
      const { frames } = normalize(run.result.messages, run.result.report.format);
      const issued = new Set<string>();
      const answered = new Set<string>();
      for (const frame of frames) {
        if (frame.kind === 'tool_call') for (const id of frame.toolCallIds) issued.add(id);
        else if (frame.kind === 'tool_result') for (const id of frame.toolCallIds) answered.add(id);
      }
      expect([...answered].sort()).toEqual([...issued].sort());
      // Every fixture but the plain chat has pairs to protect.
      if (name !== 'plain-chat.json') expect(issued.size).toBeGreaterThan(0);
    });

    it('2. never drops a system message', () => {
      const systems = run.messages.filter(isSystem);
      // The anthropic fixture carries no system message: its `system` lives outside the array.
      if (name !== 'anthropic-tool-loop.json') expect(systems.length).toBeGreaterThan(0);
      for (const message of systems) {
        expect(run.result.messages).toContain(message);
        const index = run.messages.indexOf(message);
        const unit = run.result.report.units.find((u) => u.indices.includes(index));
        expect(unit).toBeDefined();
        expect(survives(unit?.decision ?? 'dropped')).toBe(true);
        expect(unit?.reason).toMatch(/pinned:system/);
      }
    });

    it("3. returns the caller's own message objects, in order, unmodified", () => {
      expect(run.kept.length).toBeGreaterThan(0);
      expect(run.kept.length).toBeLessThan(run.messages.length);
      const order = run.kept.map((m) => run.messages.indexOf(m));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(new Set(order).size).toBe(order.length);
      expect(JSON.stringify(run.messages)).toBe(run.snapshot);

      // At most one appended corrective system message, last, and never inside an anthropic array.
      expect(run.extras.length).toBeLessThanOrEqual(1);
      if (run.result.report.format === 'anthropic') expect(run.extras).toHaveLength(0);
      for (const extra of run.extras) {
        expect(isSystem(extra)).toBe(true);
        expect(run.result.messages.at(-1)).toBe(extra);
      }

      // The report agrees with the array: the surviving units are exactly the kept indices.
      const fromReport = run.result.report.units
        .filter((u) => survives(u.decision))
        .flatMap((u) => u.indices)
        .sort((a, b) => a - b);
      expect(order).toEqual(fromReport);
    });

    it('4. attributes every drop with a reason, and pKeep when Jev judged the unit', () => {
      const { report } = run.result;
      const ids = new Set(report.units.map((u) => u.unit));
      const dropped = report.units.filter((u) => !survives(u.decision));
      expect(dropped.length).toBeGreaterThan(0);
      for (const u of dropped) {
        expect(u.reason, u.unit).not.toBe('');
        for (const i of u.indices) {
          const original = run.messages[i];
          expect(original).toBeDefined();
          if (original !== undefined) expect(run.result.messages).not.toContain(original);
        }
        switch (u.decision) {
          case 'dropped':
            expect(u.reason).toMatch(/^jev:drop/);
            expectProbability(u.pKeep);
            expectProbability(u.confidence);
            // The thresholds are honored: P(drop) ≥ 0.7 on the first pass, ≥ 0.5 on the second.
            expect(1 - (u.pKeep ?? 1)).toBeGreaterThanOrEqual(
              (u.reason === 'jev:drop-2nd-pass' ? 0.5 : 0.7) - 1e-9,
            );
            break;
          case 'budget':
            expect(u.reason).toBe('budget');
            // A budget drop is only ever a unit Jev judged and voted to keep at the threshold; a
            // unit Jev never saw is kept, so every drop carries a probability.
            expectProbability(u.pKeep);
            break;
          case 'duplicate': {
            const survivor = /^duplicate of (u\d+)$/.exec(u.reason)?.[1];
            expect(survivor, u.reason).toBeDefined();
            expect(ids.has(survivor ?? '')).toBe(true);
            expect(survivor).not.toBe(u.unit);
            expect(u.pKeep).toBeUndefined(); // Jev never saw it; the reason is the attribution.
            break;
          }
          default:
            expect.unreachable(`unexpected drop decision ${u.decision} for ${u.unit}`);
        }
      }
    });

    it('5. fails open on a bad key: input unchanged, reason in the report, key never echoed', async () => {
      const result = await compact(run.messages, {
        goal: GOAL,
        maxTokens: MAX_TOKENS,
        apiKey: BAD_KEY,
      });
      expect(result.compacted).toBe(false);
      expect(result.blocked).toBe(false);
      expect(result.report.skipped).toBe('jev_unavailable');
      expect(result.report.jev).toBeUndefined();
      expect(result.report.error).toMatch(/401|authenticat/i);
      const realKey = process.env.TYPESAFE_API_KEY ?? '';
      if (realKey !== '') expect(result.report.error ?? '').not.toContain(realKey);

      expect(result.messages).toHaveLength(run.messages.length);
      for (const [i, message] of run.messages.entries()) expect(result.messages[i]).toBe(message);
      expect(JSON.stringify(run.messages)).toBe(run.snapshot);
      expect(result.report.tokensAfter).toBe(result.report.tokensBefore);
      expect(result.report.messagesAfter).toBe(result.report.messagesBefore);

      // No unit claims a drop, and the regex Foreman still ran.
      for (const u of result.report.units)
        expect(survives(u.decision), `${u.unit} ${u.decision}`).toBe(true);
      expect(
        result.report.foreman.some((f) => f.source === 'pattern' && f.kind === 'destructive'),
      ).toBe(true);

      // failClosed flips the policy.
      await expect(
        compact(run.messages, { goal: GOAL, apiKey: BAD_KEY, failClosed: true }),
      ).rejects.toBeInstanceOf(CompactionUnavailableError);
    });

    it('6. lands at or under maxTokens, or the report explains the overshoot', () => {
      const { report } = run.result;
      const { pre, minKeep } = run.analysis;
      const survivors = report.units.filter((u) => survives(u.decision));
      const unitTokens = survivors.reduce((sum, u) => sum + u.tokens, 0);
      const extrasTokens = report.tokensAfter - unitTokens;
      expect(extrasTokens).toBe(messagesTokens(run.extras));
      if (report.tokensAfter <= MAX_TOKENS) return;

      const pinned = survivors.filter((u) => pre.pinned.has(u.unit));
      const droppable = survivors.filter((u) => !pre.pinned.has(u.unit));
      const pinnedTokens = pinned.reduce((sum, u) => sum + u.tokens, 0);
      const why =
        `${report.tokensAfter} > ${MAX_TOKENS}: pinned units ${pinnedTokens} tokens ` +
        `(${pinned.map((u) => u.reason).join('; ')}), ${droppable.length} droppable survivor(s) ` +
        `at minKeep=${minKeep}, corrective prompt ${extrasTokens} tokens`;
      const pinsAndMinKeep = droppable.length <= minKeep;
      const onlyTheCorrective = unitTokens <= MAX_TOKENS && extrasTokens > 0;
      expect(pinsAndMinKeep || onlyTheCorrective, why).toBe(true);
      for (const u of pinned) expect(u.reason).toMatch(/pinned:/);
      console.info(`${name}: over budget by design — ${why}`);
    });
  });

  it('explains an overshoot that the pins alone force (plain chat at 1,500 tokens)', async () => {
    const messages = loadFixture('plain-chat.json');
    const options: CompactOptions = { goal: GOAL, maxTokens: 1_500 };
    const result = await compact(messages, options);
    const { pre, minKeep } = analyze(messages, options);
    expect(result.compacted).toBe(true);

    const survivors = result.report.units.filter((u) => survives(u.decision));
    const pinnedTokens = survivors
      .filter((u) => pre.pinned.has(u.unit))
      .reduce((sum, u) => sum + u.tokens, 0);
    expect(pinnedTokens).toBeGreaterThan(1_500); // this fixture's pins cannot fit the budget
    expect(result.report.tokensAfter).toBeGreaterThan(1_500);

    // Everything droppable went, down to exactly minKeep judged units; each drop says why.
    const droppable = survivors.filter((u) => !pre.pinned.has(u.unit));
    expect(droppable).toHaveLength(minKeep);
    for (const u of result.report.units) {
      if (survives(u.decision)) continue;
      expect(['dropped', 'budget', 'duplicate']).toContain(u.decision);
      expect(u.reason).toMatch(/^(jev:drop|budget|duplicate of u\d+)/);
    }
    expect(result.report.units.some((u) => u.decision === 'budget')).toBe(true);
  });

  it('withCompaction hands a wrapped function the compacted originals, then honors the cooldown', async () => {
    const messages = loadFixture('openai-tool-loop.json');
    const seen: AnyMessage[][] = [];
    const reports: CompactionReport[] = [];
    const target = async (batch: AnyMessage[]): Promise<number> => {
      seen.push(batch);
      return batch.length;
    };
    const wrapped = withCompaction(target, {
      goal: GOAL,
      maxTokens: MAX_TOKENS,
      onReport: (report) => reports.push(report),
    });

    // Over budget → compacted: a new array holding the caller's objects (plus at most the corrective).
    const first = await wrapped(messages);
    expect(first).toBeLessThan(messages.length);
    const batch = seen[0];
    expect(batch).toBeDefined();
    expect(batch).not.toBe(messages);
    const inputSet = new Set<AnyMessage>(messages);
    const extras = (batch ?? []).filter((m) => !inputSet.has(m));
    expect(extras.length).toBeLessThanOrEqual(1);
    expect(reports[0]?.skipped).toBeUndefined();
    expect(reports[0]?.jev).toBeDefined();

    // Cooldown (default 1 turn): the next call passes the history through untouched.
    const second = await wrapped(messages);
    expect(second).toBe(messages.length);
    expect(reports[1]?.skipped).toBe('cooldown');
    for (const [i, message] of messages.entries()) expect(seen[1]?.[i]).toBe(message);
  });
});
