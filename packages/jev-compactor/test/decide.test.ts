import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  blockingFinding,
  correctivePrompt,
  DEFAULT_CORRECTIVE,
  decide,
  foremanLevels,
  reassemble,
} from '../src/decide.js';
import type { JevAnswers } from '../src/jev.js';
import { groupUnits, normalize } from '../src/normalize.js';
import type { PrepassResult } from '../src/prepass.js';
import { estimateTokens } from '../src/tokens.js';
import type {
  AnyMessage,
  ForemanFinding,
  ForemanKind,
  MessageFormat,
  ResolvedOptions,
  Unit,
  UnitReport,
} from '../src/types.js';

// ───────────────────────────── helpers ─────────────────────────────

type FixtureName = 'openai-tool-loop' | 'anthropic-tool-loop' | 'langchain' | 'plain-chat';

function loadFixture(name: FixtureName): AnyMessage[] {
  const url = new URL(`../fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as AnyMessage[];
}

function unitsOf(messages: AnyMessage[], format: MessageFormat | 'auto' = 'auto'): Unit[] {
  return groupUnits(normalize(messages, format).frames);
}

/** Plain chat of `n` single-frame units whose JSON is the same length, so every unit has equal tokens. */
function chat(n: number, chars = 60): AnyMessage[] {
  if (n > 10) throw new Error('chat() keeps the index to one digit so unit sizes stay equal');
  // One role for all: `user` and `assistant` differ in length, which would skew the JSON size.
  return Array.from({ length: n }, (_, i) => ({
    role: 'user',
    content: `m${i} ${'x'.repeat(chars)}`,
  }));
}

function opts(overrides: Partial<ResolvedOptions> = {}): ResolvedOptions {
  return {
    goal: undefined,
    maxTokens: 15_000,
    trigger: 'always',
    keepRecent: 4,
    pinCodeWithin: 12,
    pin: undefined,
    dropThreshold: 0.7,
    dropThresholdSecondPass: 0.5,
    minKeep: 2,
    allowTruncate: false,
    truncateHeadChars: 300,
    excerptChars: 1_500,
    stateTokens: 20_000,
    requestTokens: 56_000,
    concurrency: 8,
    safetyGating: false,
    reviewThreshold: 0.35,
    actionThreshold: 0.7,
    patterns: [],
    correctivePrompts: { ...DEFAULT_CORRECTIVE },
    failClosed: false,
    countTokens: estimateTokens,
    format: 'auto',
    client: undefined,
    apiKey: undefined,
    model: undefined,
    baseURL: undefined,
    timeoutMs: 10_000,
    signal: undefined,
    onReport: undefined,
    onEscrow: undefined,
    ...overrides,
  };
}

interface PreSpec {
  pinned?: Record<string, string>;
  duplicates?: Record<string, string>;
  findings?: ForemanFinding[];
}

function pre(units: Unit[], spec: PreSpec = {}): PrepassResult {
  const pinned = new Map(Object.entries(spec.pinned ?? {}));
  const duplicates = new Map(Object.entries(spec.duplicates ?? {}));
  return {
    pinned,
    duplicates,
    candidates: units.filter((u) => !pinned.has(u.id) && !duplicates.has(u.id)),
    findings: spec.findings ?? [],
  };
}

type Judgement = number | [pKeep: number, confidence: number];

interface AnswerSpec {
  units?: Record<string, Judgement>;
  foreman?: Partial<Record<ForemanKind, number>>;
  progress?: number;
}

function answers(spec: AnswerSpec = {}): JevAnswers {
  const units = new Map<string, { pKeep: number; confidence: number }>();
  for (const [id, j] of Object.entries(spec.units ?? {})) {
    units.set(
      id,
      typeof j === 'number' ? { pKeep: j, confidence: 0.9 } : { pKeep: j[0], confidence: j[1] },
    );
  }
  return {
    units,
    foreman: { destructive: 0, exfiltration: 0, thrashing: 0, goal_drift: 0, ...spec.foreman },
    progress: spec.progress,
    telemetry: {
      model: 'jev-latest',
      requests: 1,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      requestIds: [],
      estimatedUsd: 0,
      stateTokens: 0,
      fitStage: 0,
      unjudged: 0,
    },
  };
}

function pattern(
  kind: 'destructive' | 'exfiltration',
  indices: number[],
  evidence = 'rm-rf: rm -rf src',
): ForemanFinding {
  return { kind, source: 'pattern', probability: 1, level: 'action', indices, evidence };
}

function jevFinding(
  kind: ForemanKind,
  probability: number,
  level: 'review' | 'action',
): ForemanFinding {
  return { kind, source: 'jev', probability, level, indices: [] };
}

function report(result: { reports: UnitReport[] }, id: string): UnitReport {
  const r = result.reports.find((x) => x.unit === id);
  if (r === undefined) throw new Error(`no report for ${id}`);
  return r;
}

function unitAt(units: Unit[], index: number): Unit {
  const u = units.find((x) => x.indices.includes(index));
  if (u === undefined) throw new Error(`no unit holds message ${index}`);
  return u;
}

function decisions(result: { reports: UnitReport[] }): string[] {
  return result.reports.map((r) => `${r.unit}:${r.decision}`);
}

// ───────────────────────────── decide: thresholds and precedence ─────────────────────────────

describe('decide: Jev threshold', () => {
  const units = unitsOf(chat(6));

  it('drops iff 1 - pKeep ≥ dropThreshold, with pKeep/confidence and the drop probability in the reason', () => {
    const result = decide(
      units,
      pre(units),
      answers({ units: { u0: [0.3, 0.8], u1: 0.31, u2: 0.05, u3: 0.95, u4: 0.7, u5: 0.29 } }),
      opts({ minKeep: 0 }),
    );
    expect(decisions(result)).toEqual([
      'u0:dropped',
      'u1:kept',
      'u2:dropped',
      'u3:kept',
      'u4:kept',
      'u5:dropped',
    ]);
    expect(report(result, 'u0')).toMatchObject({
      pKeep: 0.3,
      confidence: 0.8,
      reason: 'jev:drop p=0.70',
    });
    expect(report(result, 'u2').reason).toBe('jev:drop p=0.95');
    expect(report(result, 'u3')).toMatchObject({
      pKeep: 0.95,
      confidence: 0.9,
      reason: 'jev:keep p=0.95',
    });
    expect([...result.keptIds]).toEqual(['u1', 'u3', 'u4']);
  });

  it('honors a custom threshold at the exact boundary despite float noise (1 - 0.55)', () => {
    const result = decide(
      units,
      pre(units),
      answers({ units: { u0: 0.55, u1: 0.56 } }),
      opts({ dropThreshold: 0.45, minKeep: 0 }),
    );
    expect(report(result, 'u0').decision).toBe('dropped');
    expect(report(result, 'u1').decision).toBe('kept');
  });

  it('gives pinned and duplicate units precedence over Jev and carries the prepass reason', () => {
    const result = decide(
      units,
      pre(units, {
        pinned: { u0: 'pinned:system', u5: 'pinned:recent' },
        duplicates: { u2: 'duplicate of u4' },
      }),
      answers({ units: { u0: 0.0, u2: 1.0, u5: 0.0, u1: 0.9, u3: 0.9, u4: 0.9 } }),
      opts(),
    );
    expect(report(result, 'u0')).toEqual({
      unit: 'u0',
      indices: [0],
      decision: 'pinned',
      reason: 'pinned:system',
      tokens: units[0]?.tokens,
    });
    expect(report(result, 'u5')).toMatchObject({ decision: 'pinned', reason: 'pinned:recent' });
    expect(report(result, 'u2')).toMatchObject({
      decision: 'duplicate',
      reason: 'duplicate of u4',
    });
    expect('pKeep' in report(result, 'u2')).toBe(false);
    expect([...result.keptIds]).toEqual(['u0', 'u1', 'u3', 'u4', 'u5']);
  });

  it('keeps unjudged candidates (absent from answers.units) without a pKeep', () => {
    const result = decide(
      units,
      pre(units),
      answers({ units: { u0: 0.0, u1: 0.9 } }),
      opts({ minKeep: 0 }),
    );
    for (const id of ['u2', 'u3', 'u4', 'u5']) {
      const r = report(result, id);
      expect(r.decision).toBe('kept');
      expect(r.reason).toBe('unjudged');
      expect('pKeep' in r).toBe(false);
      expect('confidence' in r).toBe(false);
    }
    expect(report(result, 'u0').decision).toBe('dropped');
  });

  it('with answers undefined keeps everything that is neither pinned nor duplicate, even over budget', () => {
    const result = decide(
      units,
      pre(units, { pinned: { u0: 'pinned:system' }, duplicates: { u3: 'duplicate of u5' } }),
      undefined,
      opts({ maxTokens: 0, minKeep: 0 }),
    );
    expect(decisions(result)).toEqual([
      'u0:pinned',
      'u1:kept',
      'u2:kept',
      'u3:duplicate',
      'u4:kept',
      'u5:kept',
    ]);
    expect(report(result, 'u1').reason).toBe('jev:unavailable');
    expect([...result.keptIds]).toEqual(['u0', 'u1', 'u2', 'u4', 'u5']);
    expect('progress' in result).toBe(false);
    expect(result.foreman).toEqual([]);
  });

  it('passes pattern findings through when answers are undefined', () => {
    const finding = pattern('destructive', [1]);
    const result = decide(units, pre(units, { findings: [finding] }), undefined, opts());
    expect(result.foreman).toEqual([finding]);
    expect(report(result, 'u1').decision).toBe('flagged');
  });

  it('reports progress only when Jev scored it', () => {
    expect(decide(units, pre(units), answers({ progress: 1.5 }), opts()).progress).toBe(1.5);
    expect('progress' in decide(units, pre(units), answers(), opts())).toBe(false);
  });
});

// ───────────────────────────── decide: minKeep ─────────────────────────────

describe('decide: minKeep', () => {
  const units = unitsOf(chat(5));
  const allDrop = { u0: 0.0, u1: 0.1, u2: 0.05, u3: 0.0, u4: 0.2 };

  it('re-keeps the newest dropped candidates up to minKeep', () => {
    const result = decide(units, pre(units), answers({ units: allDrop }), opts({ minKeep: 2 }));
    expect(decisions(result)).toEqual([
      'u0:dropped',
      'u1:dropped',
      'u2:dropped',
      'u3:kept',
      'u4:kept',
    ]);
    expect(report(result, 'u4').reason).toBe('minKeep (was jev:drop p=0.80)');
    expect(report(result, 'u3')).toMatchObject({
      pKeep: 0,
      reason: 'minKeep (was jev:drop p=1.00)',
    });
    expect([...result.keptIds]).toEqual(['u3', 'u4']);
  });

  it('is a no-op at 0 and bounded by the number of candidates', () => {
    expect(
      decide(units, pre(units), answers({ units: allDrop }), opts({ minKeep: 0 })).keptIds.size,
    ).toBe(0);
    expect(
      decide(units, pre(units), answers({ units: allDrop }), opts({ minKeep: 99 })).keptIds.size,
    ).toBe(5);
  });

  it('counts candidates only: pins neither satisfy it nor are touched by it', () => {
    const result = decide(
      units,
      pre(units, { pinned: { u0: 'pinned:system', u1: 'pinned:recent', u2: 'pinned:recent' } }),
      answers({ units: { u3: 0.0, u4: 0.0 } }),
      opts({ minKeep: 2 }),
    );
    expect(decisions(result)).toEqual([
      'u0:pinned',
      'u1:pinned',
      'u2:pinned',
      'u3:kept',
      'u4:kept',
    ]);
  });
});

// ───────────────────────────── decide: budget ─────────────────────────────

describe('decide: budget', () => {
  const units = unitsOf(chat(6));
  const t = units[0]?.tokens ?? 0;
  const total = units.reduce((sum, u) => sum + u.tokens, 0);
  // Every unit judged kept at 0.7; u1 and u3 are eligible for the 0.5 second pass, u0/u2/u4/u5 are not.
  const judged = { u0: 0.9, u1: 0.45, u2: 0.6, u3: 0.5, u4: 0.9, u5: 0.9 };

  it('sizes its units equally (test precondition)', () => {
    expect(t).toBeGreaterThan(0);
    expect(units.every((u) => u.tokens === t)).toBe(true);
    expect(total).toBe(6 * t);
  });

  it('drops nothing when kept tokens are exactly at maxTokens', () => {
    const result = decide(
      units,
      pre(units),
      answers({ units: judged }),
      opts({ maxTokens: total }),
    );
    expect(result.keptIds.size).toBe(6);
  });

  it('runs the second-pass threshold first, lowest P(keep) first, and stops as soon as it fits', () => {
    const result = decide(
      units,
      pre(units),
      answers({ units: judged }),
      opts({ maxTokens: total - 1 }),
    );
    expect(decisions(result)).toEqual([
      'u0:kept',
      'u1:dropped',
      'u2:kept',
      'u3:kept',
      'u4:kept',
      'u5:kept',
    ]);
    expect(report(result, 'u1')).toMatchObject({ pKeep: 0.45, reason: 'jev:drop-2nd-pass' });
  });

  it('budget drops go by lowest P(keep) first, not by age', () => {
    // u1 is the least certain keep but is not second-pass eligible (P(drop) = 0.45 < 0.5), and it is
    // not the oldest; the budget pass must still take it before u0.
    const result = decide(
      units,
      pre(units),
      answers({ units: { u0: 0.95, u1: 0.55, u2: 0.9, u3: 0.8, u4: 0.9, u5: 0.9 } }),
      opts({ maxTokens: total - 1 }),
    );
    expect(decisions(result)).toEqual([
      'u0:kept',
      'u1:budget',
      'u2:kept',
      'u3:kept',
      'u4:kept',
      'u5:kept',
    ]);
    expect(report(result, 'u1')).toMatchObject({ pKeep: 0.55, reason: 'budget' });
  });

  it('then drops the lowest-P(keep) kept candidates as budget (oldest first on ties), never below minKeep', () => {
    const result = decide(
      units,
      pre(units),
      answers({ units: judged }),
      opts({ maxTokens: 0, minKeep: 2 }),
    );
    expect(decisions(result)).toEqual([
      'u0:budget',
      'u1:dropped',
      'u2:budget',
      'u3:dropped',
      'u4:kept',
      'u5:kept',
    ]);
    expect(report(result, 'u0')).toMatchObject({ pKeep: 0.9, reason: 'budget' });
    expect(report(result, 'u3').reason).toBe('jev:drop-2nd-pass');
    expect([...result.keptIds]).toEqual(['u4', 'u5']);
  });

  it('never touches pins, even when they alone exceed the budget', () => {
    const result = decide(
      units,
      pre(units, { pinned: { u0: 'pinned:system', u5: 'pinned:recent' } }),
      answers({ units: judged }),
      opts({ maxTokens: 0, minKeep: 1 }),
    );
    expect(decisions(result)).toEqual([
      'u0:pinned',
      'u1:dropped',
      'u2:budget',
      'u3:dropped',
      'u4:kept',
      'u5:pinned',
    ]);
  });

  it('never budget-drops a unit Jev did not see: unjudged candidates stay, judged-kept ones go first', () => {
    const result = decide(
      units,
      pre(units),
      answers({ units: { u3: 0.45, u4: 0.9, u5: 0.9 } }),
      opts({ maxTokens: 0, minKeep: 2 }),
    );
    expect(decisions(result)).toEqual([
      'u0:kept',
      'u1:kept',
      'u2:kept',
      'u3:dropped',
      'u4:budget',
      'u5:budget',
    ]);
    for (const id of ['u0', 'u1', 'u2']) expect(report(result, id).reason).toBe('unjudged');
    // Every drop is attributable with Jev's probability.
    for (const r of result.reports) {
      if (r.decision === 'budget' || r.decision === 'dropped') expect(r.pKeep).toBeDefined();
    }
  });

  it('minKeep re-keeps survive the budget pass', () => {
    const result = decide(
      units,
      pre(units),
      answers({ units: { u0: 0, u1: 0, u2: 0, u3: 0, u4: 0, u5: 0 } }),
      opts({ maxTokens: 0, minKeep: 2 }),
    );
    expect([...result.keptIds]).toEqual(['u4', 'u5']);
  });
});

// ───────────────────────────── decide: flagged ─────────────────────────────

describe('decide: flagged', () => {
  const units = unitsOf(chat(4));

  it('flags kept and pinned units implicated in action-level findings; they stay in keptIds', () => {
    const findings = [
      pattern('destructive', [0], 'rm-rf: rm -rf src'),
      pattern('exfiltration', [2], 'curl-env: curl … .env'),
    ];
    const result = decide(
      units,
      pre(units, { pinned: { u0: 'pinned:system' }, findings }),
      answers({ units: { u1: 0.9, u2: 0.9, u3: 0.9 } }),
      opts(),
    );
    expect(decisions(result)).toEqual(['u0:flagged', 'u1:kept', 'u2:flagged', 'u3:kept']);
    expect(report(result, 'u0').reason).toBe(
      'flagged:destructive rm-rf: rm -rf src (was pinned:system)',
    );
    expect(report(result, 'u2').reason).toBe(
      'flagged:exfiltration curl-env: curl … .env (was jev:keep p=0.90)',
    );
    expect([...result.keptIds]).toEqual(['u0', 'u1', 'u2', 'u3']);
    expect(result.foreman).toEqual(findings);
  });

  it('does not resurrect a dropped unit and ignores review-level and whole-state findings', () => {
    const result = decide(
      units,
      pre(units, { findings: [pattern('destructive', [1])] }),
      answers({
        units: { u0: 0.9, u1: 0.0, u2: 0.9, u3: 0.9 },
        foreman: { thrashing: 0.9, goal_drift: 0.5 },
      }),
      opts(),
    );
    expect(decisions(result)).toEqual(['u0:kept', 'u1:dropped', 'u2:kept', 'u3:kept']);
    expect(result.foreman.map((f) => `${f.source}:${f.kind}:${f.level}`)).toEqual([
      'pattern:destructive:action',
      'jev:thrashing:action',
      'jev:goal_drift:review',
    ]);
  });

  it('flags a multi-frame tool unit when any of its messages is implicated', () => {
    const messages = loadFixture('openai-tool-loop');
    const fixtureUnits = unitsOf(messages);
    const target = unitAt(fixtureUnits, 5); // the `cat src/auth.ts` result, inside a 3-message unit
    expect(target.indices.length).toBeGreaterThan(1);
    const result = decide(
      fixtureUnits,
      pre(fixtureUnits, { findings: [pattern('destructive', [5])] }),
      answers({ units: { [target.id]: 0.9 } }),
      opts(),
    );
    expect(report(result, target.id).decision).toBe('flagged');
  });
});

// ───────────────────────────── decide: shape and purity ─────────────────────────────

describe('decide: shape and purity', () => {
  it('returns one report per unit in unit order with copied indices and tokens', () => {
    const units = unitsOf(loadFixture('openai-tool-loop'));
    const result = decide(units, pre(units), answers(), opts());
    expect(result.reports.map((r) => r.unit)).toEqual(units.map((u) => u.id));
    for (const [i, r] of result.reports.entries()) {
      const u = units[i];
      expect(r.indices).toEqual(u?.indices);
      expect(r.indices).not.toBe(u?.indices);
      expect(r.tokens).toBe(u?.tokens);
    }
  });

  it('does not mutate units, the prepass result or the answers', () => {
    const units = unitsOf(chat(5));
    const p = pre(units, {
      pinned: { u0: 'pinned:system' },
      findings: [pattern('destructive', [1])],
    });
    const a = answers({
      units: { u1: 0.0, u2: 0.9, u3: 0.1, u4: 0.9 },
      foreman: { thrashing: 0.8 },
      progress: 1,
    });
    const before = JSON.stringify({
      units,
      p: { ...p, pinned: [...p.pinned], duplicates: [...p.duplicates] },
      a: { ...a, units: [...a.units] },
    });
    decide(units, p, a, opts({ maxTokens: 0 }));
    const after = JSON.stringify({
      units,
      p: { ...p, pinned: [...p.pinned], duplicates: [...p.duplicates] },
      a: { ...a, units: [...a.units] },
    });
    expect(after).toBe(before);
  });

  it('works end to end on the openai fixture: the pleasantry is dropped, pins and the duplicate survive as such', () => {
    const messages = loadFixture('openai-tool-loop');
    const units = unitsOf(messages);
    const pleasantry = unitAt(units, 8);
    const authRead = unitAt(units, 5);
    const last = units.slice(-4);
    const pinned: Record<string, string> = {
      u0: 'pinned:system',
      [authRead.id]: 'pinned:goal-path src/auth.ts',
    };
    for (const u of last) pinned[u.id] = 'pinned:recent';
    const judged: Record<string, number> = {};
    for (const u of units) if (!(u.id in pinned)) judged[u.id] = 0.85;
    judged[pleasantry.id] = 0.04;
    const secondTestRun = unitAt(units, 16);
    delete judged[secondTestRun.id];

    const result = decide(
      units,
      pre(units, {
        pinned,
        duplicates: { [secondTestRun.id]: `duplicate of ${unitAt(units, 20).id}` },
      }),
      answers({ units: judged, progress: 2 }),
      opts(),
    );
    expect(report(result, pleasantry.id)).toMatchObject({
      decision: 'dropped',
      reason: 'jev:drop p=0.96',
    });
    expect(report(result, 'u0').decision).toBe('pinned');
    expect(report(result, authRead.id)).toMatchObject({
      decision: 'pinned',
      reason: 'pinned:goal-path src/auth.ts',
    });
    expect(report(result, secondTestRun.id).decision).toBe('duplicate');
    expect(result.keptIds.has(pleasantry.id)).toBe(false);
    expect(result.keptIds.has(secondTestRun.id)).toBe(false);
    expect(result.keptIds.size).toBe(units.length - 2);
    expect(result.progress).toBe(2);

    const out = reassemble(messages, units, result.keptIds, 'openai');
    expect(out.messages).toHaveLength(messages.length - 1 - secondTestRun.indices.length);
    expect(out.messages.includes(messages[8] as AnyMessage)).toBe(false);
    expect(out.messages.every((m) => messages.includes(m))).toBe(true);
  });
});

// ───────────────────────────── foremanLevels ─────────────────────────────

describe('foremanLevels', () => {
  const thresholds = { reviewThreshold: 0.35, actionThreshold: 0.7 };

  it('omits below 0.35, reviews from 0.35, acts from 0.70', () => {
    const levels = foremanLevels(
      { destructive: 0.34, exfiltration: 0.35, thrashing: 0.69, goal_drift: 0.7 },
      [],
      thresholds,
    );
    expect(levels.map((f) => `${f.kind}:${f.level}:${f.probability}`)).toEqual([
      'goal_drift:action:0.7',
      'thrashing:review:0.69',
      'exfiltration:review:0.35',
    ]);
    expect(levels.every((f) => f.source === 'jev' && f.indices.length === 0)).toBe(true);
  });

  it('passes pattern findings through as the same objects and returns only them without nouls', () => {
    const p = pattern('destructive', [3]);
    expect(foremanLevels(undefined, [p], thresholds)).toEqual([p]);
    expect(foremanLevels(undefined, [p], thresholds)[0]).toBe(p);
    expect(
      foremanLevels(
        { destructive: 0.1, exfiltration: 0.2, thrashing: 0.3, goal_drift: 0.34 },
        [],
        thresholds,
      ),
    ).toEqual([]);
  });

  it('sorts action first, then probability descending, with the regex floor leading ties', () => {
    const p = pattern('exfiltration', [7]);
    const levels = foremanLevels(
      { destructive: 0.5, exfiltration: 1, thrashing: 0.75, goal_drift: 0.4 },
      [p],
      thresholds,
    );
    expect(levels.map((f) => `${f.source}:${f.kind}:${f.level}`)).toEqual([
      'pattern:exfiltration:action',
      'jev:exfiltration:action',
      'jev:thrashing:action',
      'jev:destructive:review',
      'jev:goal_drift:review',
    ]);
    expect(levels[0]).toBe(p);
  });

  it('honors custom thresholds', () => {
    const levels = foremanLevels(
      { destructive: 0.5, exfiltration: 0.2, thrashing: 0.9, goal_drift: 0.1 },
      [],
      { reviewThreshold: 0.2, actionThreshold: 0.5 },
    );
    expect(levels.map((f) => `${f.kind}:${f.level}`)).toEqual([
      'thrashing:action',
      'destructive:action',
      'exfiltration:review',
    ]);
  });
});

// ───────────────────────────── pending action: blockingFinding, foremanLevels ─────────────────────────────

describe('blockingFinding', () => {
  it('blocks only on an action-level destructive/exfiltration finding that implicates the pending action', () => {
    const pending = [7, 8];
    const older = pattern('destructive', [1]);
    const here = pattern('exfiltration', [8]);
    expect(blockingFinding([older], pending)).toBeUndefined();
    expect(blockingFinding([older, here], pending)).toBe(here);
    expect(blockingFinding([here], [])).toBeUndefined(); // nothing pending
  });

  it('never blocks on thrashing or goal drift, at any level', () => {
    const findings = [
      jevFinding('thrashing', 0.99, 'action'),
      jevFinding('goal_drift', 0.95, 'action'),
    ];
    expect(blockingFinding(findings, [0, 1, 2])).toBeUndefined();
    expect(
      blockingFinding(
        findings.map((f) => ({ ...f, indices: [2] })),
        [2],
      ),
    ).toBeUndefined();
  });

  it('blocks on a Jev destructive/exfiltration action finding stamped with the pending action, not a review one', () => {
    const action = { ...jevFinding('destructive', 0.9, 'action'), indices: [7] };
    expect(blockingFinding([action], [7])).toBe(action);
    expect(
      blockingFinding([{ ...jevFinding('exfiltration', 0.5, 'review'), indices: [7] }], [7]),
    ).toBeUndefined();
    expect(blockingFinding([jevFinding('destructive', 0.9, 'action')], [7])).toBeUndefined(); // whole-state, no frame
  });
});

describe('foremanLevels: the pending action', () => {
  const thresholds = { reviewThreshold: 0.35, actionThreshold: 0.7 };

  it('stamps Jev destructive/exfiltration findings with the pending indices; thrashing/goal_drift carry none', () => {
    const levels = foremanLevels(
      { destructive: 0.9, exfiltration: 0.4, thrashing: 0.8, goal_drift: 0.5 },
      [],
      thresholds,
      [3, 4],
    );
    expect(levels.map((f) => [f.kind, f.level, f.indices])).toEqual([
      ['destructive', 'action', [3, 4]],
      ['thrashing', 'action', []],
      ['goal_drift', 'review', []],
      ['exfiltration', 'review', [3, 4]],
    ]);
    expect(
      foremanLevels(
        { destructive: 0.9, exfiltration: 0, thrashing: 0, goal_drift: 0 },
        [],
        thresholds,
      )[0]?.indices,
    ).toEqual([]);
  });

  it('decide flags the pending unit when Jev calls its action destructive', () => {
    const messages: AnyMessage[] = [
      { role: 'user', content: 'free up space' },
      { role: 'assistant', content: 'wiping the volume now' },
    ];
    const units = unitsOf(messages);
    const result = decide(
      units,
      pre(units),
      answers({ units: { u0: 0.9, u1: 0.9 }, foreman: { destructive: 0.95 } }),
      opts(),
    );
    expect(report(result, 'u1')).toMatchObject({
      decision: 'flagged',
      reason: 'flagged:destructive (was jev:keep p=0.90)',
    });
    expect(report(result, 'u0').decision).toBe('kept');
    expect(result.foreman).toMatchObject([
      { kind: 'destructive', source: 'jev', level: 'action', indices: [1] },
    ]);
    // No pending action (the user spoke last): the same finding names no frame and flags nothing.
    const asked = unitsOf([...messages, { role: 'user', content: 'wait, which volume?' }]);
    const later = decide(
      asked,
      pre(asked),
      answers({ units: { u0: 0.9, u1: 0.9, u2: 0.9 }, foreman: { destructive: 0.95 } }),
      opts(),
    );
    expect(later.foreman[0]?.indices).toEqual([]);
    expect(later.reports.every((r) => r.decision === 'kept')).toBe(true);
  });
});

// ───────────────────────────── correctivePrompt ─────────────────────────────

describe('correctivePrompt', () => {
  const goal = 'fix src/auth.ts ($& stays literal)';

  it('has default templates for both kinds, the goal one with a {goal} slot', () => {
    expect(Object.keys(DEFAULT_CORRECTIVE).sort()).toEqual(['goal_drift', 'thrashing']);
    expect(DEFAULT_CORRECTIVE.goal_drift).toContain('{goal}');
    expect(DEFAULT_CORRECTIVE.thrashing.startsWith('Compaction notice:')).toBe(true);
  });

  it('substitutes {goal} literally for an action-level Jev goal_drift finding', () => {
    const text = correctivePrompt([jevFinding('goal_drift', 0.9, 'action')], goal, opts());
    expect(text).toBe(DEFAULT_CORRECTIVE.goal_drift.split('{goal}').join(goal));
    expect(text).toContain('($& stays literal)');
    expect(text).not.toContain('{goal}');
  });

  it('joins thrashing and goal_drift with a blank line, once per kind, in finding order', () => {
    const findings = [
      jevFinding('goal_drift', 0.95, 'action'),
      jevFinding('thrashing', 0.8, 'action'),
      jevFinding('thrashing', 0.8, 'action'),
    ];
    expect(correctivePrompt(findings, goal, opts())).toBe(
      `${DEFAULT_CORRECTIVE.goal_drift.split('{goal}').join(goal)}\n\n${DEFAULT_CORRECTIVE.thrashing}`,
    );
  });

  it('uses the configured templates and substitutes every {goal}', () => {
    const o = opts({ correctivePrompts: { thrashing: 'T', goal_drift: 'G {goal} / {goal}' } });
    expect(
      correctivePrompt(
        [jevFinding('thrashing', 0.9, 'action'), jevFinding('goal_drift', 0.9, 'action')],
        'g',
        o,
      ),
    ).toBe('T\n\nG g / g');
  });

  it('is undefined when disabled, when nothing qualifies, for review level, and for non-Jev sources', () => {
    const action = [jevFinding('thrashing', 0.9, 'action')];
    expect(correctivePrompt(action, goal, opts({ correctivePrompts: false }))).toBeUndefined();
    expect(correctivePrompt([], goal, opts())).toBeUndefined();
    expect(
      correctivePrompt([jevFinding('thrashing', 0.6, 'review')], goal, opts()),
    ).toBeUndefined();
    expect(
      correctivePrompt(
        [jevFinding('destructive', 0.99, 'action'), pattern('destructive', [1])],
        goal,
        opts(),
      ),
    ).toBeUndefined();
    expect(
      correctivePrompt(
        [{ kind: 'thrashing', source: 'pattern', probability: 1, level: 'action', indices: [1] }],
        goal,
        opts(),
      ),
    ).toBeUndefined();
  });
});

// ───────────────────────────── reassemble ─────────────────────────────

describe('reassemble', () => {
  const FIXTURES: ReadonlyArray<[FixtureName, MessageFormat]> = [
    ['openai-tool-loop', 'openai'],
    ['anthropic-tool-loop', 'anthropic'],
    ['langchain', 'langchain'],
    ['plain-chat', 'plain'],
  ];

  it.each(FIXTURES)(
    '%s: returns the same object references in original order, dropping whole units',
    (name, format) => {
      const messages = loadFixture(name);
      const units = unitsOf(messages, format);
      const dropped = new Set([units[2]?.id, units[5]?.id, units[units.length - 3]?.id]);
      const keptIds = new Set(units.filter((u) => !dropped.has(u.id)).map((u) => u.id));
      const droppedIndices = new Set(
        units.filter((u) => dropped.has(u.id)).flatMap((u) => u.indices),
      );
      const expected = messages.filter((_, i) => !droppedIndices.has(i));

      const out = reassemble(messages, units, keptIds, format);
      expect(out.messages).toHaveLength(expected.length);
      expect(out.messages.length).toBeLessThan(messages.length);
      for (const [i, m] of out.messages.entries()) expect(m).toBe(expected[i]);
      expect('systemAddendum' in out).toBe(false);
      expect(messages).toHaveLength(units.reduce((n, u) => n + u.indices.length, 0));
    },
  );

  it('keeps everything when every unit is kept, still by reference', () => {
    const messages = loadFixture('plain-chat');
    const units = unitsOf(messages);
    const out = reassemble(messages, units, new Set(units.map((u) => u.id)), 'plain');
    expect(out.messages).toHaveLength(messages.length);
    for (const [i, m] of out.messages.entries()) expect(m).toBe(messages[i]);
    expect(out.messages).not.toBe(messages);
  });

  it('returns an empty array when nothing is kept', () => {
    const messages = chat(3);
    expect(reassemble(messages, unitsOf(messages), new Set(), 'plain').messages).toEqual([]);
  });

  it.each([
    ['openai', { role: 'system', content: 'note' }],
    ['plain', { role: 'system', content: 'note' }],
    ['langchain', { type: 'system', content: 'note' }],
  ] as const)(
    '%s: appends the addendum as a system message and no systemAddendum',
    (format, expected) => {
      const messages = chat(3);
      const units = unitsOf(messages);
      const out = reassemble(messages, units, new Set(units.map((u) => u.id)), format, 'note');
      expect(out.messages).toHaveLength(4);
      expect(out.messages[3]).toEqual(expected);
      expect(out.messages[0]).toBe(messages[0]);
      expect('systemAddendum' in out).toBe(false);
      expect(messages).toHaveLength(3);
    },
  );

  it('anthropic: leaves the array alone and returns the addendum as systemAddendum', () => {
    const messages = loadFixture('anthropic-tool-loop');
    const units = unitsOf(messages, 'anthropic');
    const out = reassemble(messages, units, new Set(units.map((u) => u.id)), 'anthropic', 'note');
    expect(out.messages).toHaveLength(messages.length);
    for (const [i, m] of out.messages.entries()) expect(m).toBe(messages[i]);
    expect(out.systemAddendum).toBe('note');
  });

  it('adds nothing for an undefined or empty addendum', () => {
    const messages = chat(2);
    const units = unitsOf(messages);
    const all = new Set(units.map((u) => u.id));
    expect(reassemble(messages, units, all, 'openai', undefined).messages).toHaveLength(2);
    expect(reassemble(messages, units, all, 'langchain', '').messages).toHaveLength(2);
    expect('systemAddendum' in reassemble(messages, units, all, 'anthropic', '')).toBe(false);
  });

  it('preserves the caller generic type', () => {
    interface Msg extends Record<string, unknown> {
      role: string;
      content: string;
      pin?: boolean;
    }
    const messages: Msg[] = [
      { role: 'user', content: 'a', pin: true },
      { role: 'assistant', content: 'b' },
    ];
    const units = unitsOf(messages);
    const out = reassemble(messages, units, new Set(['u0']), 'plain');
    const first: Msg | undefined = out.messages[0];
    expect(first?.pin).toBe(true);
    expect(out.messages).toHaveLength(1);
  });
});
