/**
 * compact() end to end against the real Jev — no mocks (workspace rule). Skipped loudly without
 * TYPESAFE_API_KEY. Cost: three fixture-sized runs per fixture, ≈ $0.003 in total.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CORRECTIVE } from '../src/decide.js';
import { compact } from '../src/engine.js';
import { loadEnvLocal } from '../src/env.js';
import { normalize } from '../src/normalize.js';
import type { AnyMessage, CompactionResult, ForemanFinding, MessageFormat } from '../src/types.js';
import { loadFixture } from './jev.helpers.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
loadEnvLocal(REPO_ROOT);

const HAS_KEY = Boolean(process.env.TYPESAFE_API_KEY);
if (!HAS_KEY) console.warn('TYPESAFE_API_KEY not set — live tests skipped');

const GOAL = 'Fix the failing unit test in src/auth.ts';
const MAX_TOKENS = 4_000;

const FIXTURES = [
  'openai-tool-loop.json',
  'anthropic-tool-loop.json',
  'langchain.json',
  'plain-chat.json',
] as const;

// ───────────────────────────── helpers ─────────────────────────────

function json(message: AnyMessage): string {
  return JSON.stringify(message);
}

/** Index of the first message whose JSON contains `needle`. */
function indexOf(messages: AnyMessage[], needle: string): number {
  const index = messages.findIndex((m) => json(m).includes(needle));
  expect(index, `no message contains ${JSON.stringify(needle)}`).toBeGreaterThanOrEqual(0);
  return index;
}

function isSystemMessage(message: AnyMessage): boolean {
  return message.role === 'system' || message.type === 'system';
}

/** Every tool result in `messages` answers a call in `messages`, and every call is answered. */
function expectToolPairsIntact(messages: AnyMessage[], format: MessageFormat): void {
  const { frames } = normalize(messages, format);
  const issued = new Set<string>();
  const answered = new Set<string>();
  for (const frame of frames) {
    if (frame.kind === 'tool_call') for (const id of frame.toolCallIds) issued.add(id);
    else if (frame.kind === 'tool_result') for (const id of frame.toolCallIds) answered.add(id);
  }
  for (const id of answered)
    expect([...issued], `result ${id} kept without its call`).toContain(id);
  for (const id of issued)
    expect([...answered], `call ${id} kept without its result`).toContain(id);
}

function correctiveFor(result: CompactionResult): ForemanFinding[] {
  return result.report.foreman.filter(
    (f) =>
      f.source === 'jev' &&
      f.level === 'action' &&
      (f.kind === 'thrashing' || f.kind === 'goal_drift'),
  );
}

// ───────────────────────────── tests ─────────────────────────────

describe.skipIf(!HAS_KEY)('compact (live)', () => {
  for (const name of FIXTURES) {
    it(`compacts ${name} under the goal, keeping originals, pairs, evidence and the rm -rf flag`, async () => {
      const messages = loadFixture(name);
      const inputSet = new Set<AnyMessage>(messages);

      const result = await compact(messages, { goal: GOAL, maxTokens: MAX_TOKENS });
      const { report } = result;

      expect(result.compacted).toBe(true);
      expect(report.skipped).toBeUndefined();
      expect(report.error).toBeUndefined();
      expect(report.goal).toBe(GOAL);
      expect(report.tokensAfter).toBeLessThan(report.tokensBefore);
      expect(report.messagesBefore).toBe(messages.length);
      expect(report.messagesAfter).toBe(result.messages.length);

      // Every kept message is the caller's object; at most one appended corrective system message.
      const extras = result.messages.filter((m) => !inputSet.has(m));
      const kept = result.messages.filter((m) => inputSet.has(m));
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.length).toBeLessThan(messages.length);
      for (const m of kept) expect(messages).toContain(m);
      // Original order is preserved.
      const keptIndices = kept.map((m) => messages.indexOf(m));
      expect(keptIndices).toEqual([...keptIndices].sort((a, b) => a - b));

      expectToolPairsIntact(result.messages, report.format);

      // The `src/auth.ts` contents (the evidence Jev alone would drop) are kept by the goal-path pin.
      const evidence = indexOf(messages, 'timingSafeEqual } from');
      expect(result.messages).toContain(messages[evidence]);
      const evidenceReport = report.units.find((u) => u.indices.includes(evidence));
      expect(evidenceReport?.decision).toBe('pinned');
      expect(evidenceReport?.reason).toMatch(/^pinned:goal-path/);

      // The `rm -rf ./src` proposal is flagged by the regex floor and still present.
      const rm = indexOf(messages, 'rm -rf ./src');
      const rmReport = report.units.find((u) => u.indices.includes(rm));
      expect(rmReport?.decision).toBe('flagged');
      expect(result.messages).toContain(messages[rm]);
      const patternHit = report.foreman.find(
        (f) => f.source === 'pattern' && f.indices.includes(rm),
      );
      expect(patternHit).toMatchObject({ kind: 'destructive', level: 'action', probability: 1 });

      // Every drop is attributable.
      for (const unit of report.units) {
        if (unit.decision === 'dropped') {
          expect(unit.pKeep).toBeDefined();
          expect(unit.reason).toMatch(/^jev:drop/);
        }
        if (unit.decision === 'budget') expect(unit.reason).toBe('budget');
        if (unit.decision === 'duplicate') expect(unit.reason).toMatch(/^duplicate of u\d+$/);
      }

      // Telemetry.
      expect(report.jev).toBeDefined();
      expect(report.jev?.requests).toBeGreaterThanOrEqual(1);
      expect(report.jev?.inputTokens).toBeGreaterThan(0);
      expect(report.jev?.model).toMatch(/^jev/);
      expect(report.progress).toBeGreaterThanOrEqual(0);
      expect(report.progress).toBeLessThanOrEqual(2);
      expect(report.latencyMs).toBeGreaterThanOrEqual(report.jev?.latencyMs ?? 0);

      // Corrective prompt: present exactly when Jev's thrashing / goal-drift fires at action level.
      const corrective = correctiveFor(result);
      const thrashing = report.foreman.find((f) => f.kind === 'thrashing' && f.source === 'jev');
      console.info(
        `${name}: ${report.tokensBefore} → ${report.tokensAfter} tokens, ${report.messagesBefore} → ${report.messagesAfter} messages, ` +
          `thrashing p=${thrashing?.probability.toFixed(2) ?? '<0.35'}, corrective=${corrective.map((f) => f.kind).join(',') || 'none'}`,
      );
      if (corrective.length > 0) {
        const expectedText = corrective.some((f) => f.kind === 'thrashing')
          ? DEFAULT_CORRECTIVE.thrashing
          : GOAL;
        if (report.format === 'anthropic') {
          expect(result.systemAddendum).toContain(expectedText);
          expect(extras).toHaveLength(0);
        } else {
          expect(result.systemAddendum).toBeUndefined();
          expect(extras).toHaveLength(1);
          const last = result.messages.at(-1) as AnyMessage;
          expect(isSystemMessage(last)).toBe(true);
          expect(String(last.content)).toContain(expectedText);
        }
      } else {
        expect(result.systemAddendum).toBeUndefined();
        expect(extras).toHaveLength(0);
      }

      // Blocking: the fixture's rm -rf was rejected by the user right after it was proposed and the
      // session went on — reported and flagged, but not the pending action, so nothing blocks …
      expect(result.blocked).toBe(false);
      const movedOn = await compact(messages, {
        goal: GOAL,
        maxTokens: MAX_TOKENS,
        safetyGating: true,
      });
      expect(movedOn.blocked).toBe(false);
      expect(
        movedOn.report.foreman.some((f) => f.source === 'pattern' && f.level === 'action'),
      ).toBe(true);

      // … whereas cut right after the proposal it is the pending action: blocked, and escrow approval unblocks.
      const proposal = messages.slice(0, rm + 1);
      const gated = await compact(proposal, {
        goal: GOAL,
        maxTokens: MAX_TOKENS,
        safetyGating: true,
      });
      expect(gated.blocked).toBe(true);
      expect(gated.report.foreman.some((f) => f.level === 'action' && f.indices.includes(rm))).toBe(
        true,
      );
      const jevOnPending = gated.report.foreman.find(
        (f) => f.source === 'jev' && f.kind === 'destructive',
      );
      console.info(
        `${name}: Jev destructive on the pending rm -rf p=${jevOnPending?.probability.toFixed(2) ?? '<0.35'}`,
      );
      if (jevOnPending !== undefined) expect(jevOnPending.indices).toEqual([rm]);

      const escrowed: ForemanFinding[] = [];
      const approved = await compact(proposal, {
        goal: GOAL,
        maxTokens: MAX_TOKENS,
        safetyGating: true,
        onEscrow: (finding) => {
          escrowed.push(finding);
          return 'approve';
        },
      });
      expect(approved.blocked).toBe(false);
      expect(escrowed).toHaveLength(1);
      expect(escrowed[0]?.level).toBe('action');
      expect(escrowed[0]?.indices).toContain(rm);
    });
  }

  it('thrashing steers with the corrective prompt and never blocks, even as the pending action', async () => {
    const goal = 'Make `pnpm test` pass in packages/api';
    const messages: AnyMessage[] = [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: goal },
    ];
    for (let i = 0; i < 7; i++) {
      messages.push({
        role: 'assistant',
        content: `Running the tests again (attempt ${i + 1}).`,
        tool_calls: [
          {
            id: `c${i}`,
            type: 'function',
            function: { name: 'bash', arguments: '{"command":"pnpm test"}' },
          },
        ],
      });
      messages.push({
        role: 'tool',
        tool_call_id: `c${i}`,
        content:
          'FAIL src/user.test.ts > creates a user\nTypeError: Cannot read properties of undefined (reading "id")\n  at src/user.ts:42:18\nTests 1 failed | 2 passed',
      });
    }
    const result = await compact(messages, { goal, safetyGating: true, maxTokens: 100_000 });
    expect(result.compacted).toBe(true);
    const thrashing = result.report.foreman.find(
      (f) => f.kind === 'thrashing' && f.source === 'jev',
    );
    console.info(`thrashing p=${thrashing?.probability.toFixed(2) ?? '<0.35'}`);
    expect(result.blocked).toBe(false);
    expect(
      result.report.foreman.some(
        (f) => f.level === 'action' && (f.kind === 'destructive' || f.kind === 'exfiltration'),
      ),
    ).toBe(false);
    if (thrashing?.level === 'action') {
      const last = result.messages.at(-1) as AnyMessage;
      expect(String(last.content)).toContain(DEFAULT_CORRECTIVE.thrashing);
    }
  });

  it('re-abridges a state Jev tokenizes far denser than the estimate (CJK) until it is accepted', async () => {
    const line =
      '這是一段用來測試壓縮器的中文對話內容，包含錯誤訊息、檔案路徑與決策記錄，並且描述了目前的進度。';
    const messages: AnyMessage[] = [{ role: 'system', content: '你是一個程式助理。' }];
    for (let i = 0; i < 260; i++) {
      messages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `${i}: ${line.repeat(6)}`,
      });
    }
    messages.push({ role: 'user', content: '請總結目前的進度。' });
    const result = await compact(messages, { goal: '請總結目前的進度。', maxTokens: 30_000 });
    console.info(
      `cjk: ${result.report.jev?.requests ?? 0} requests, fit stage ${result.report.jev?.fitStage ?? '-'}, ` +
        `${result.report.jev?.unjudged ?? 0} unjudged, ${result.report.latencyMs} ms${result.report.error === undefined ? '' : `, error: ${result.report.error}`}`,
    );
    expect(result.report.skipped).toBeUndefined();
    expect(result.compacted).toBe(true);
    expect(result.report.jev?.requests).toBeGreaterThanOrEqual(2); // at least one rejection was recovered from
  });
});
