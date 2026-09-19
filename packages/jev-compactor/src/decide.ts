/**
 * Decide (code). Turns the prepass and Jev's answers into one decision per unit, enforces the
 * invariants that must hold whether or not Jev was right or available (pins, dedup, minKeep, the
 * token budget), levels the Foreman findings, builds the corrective prompt and reassembles the
 * caller's ORIGINAL message objects. Pure and deterministic: no network, and no input is mutated.
 *
 * Two readings of the contract (ARCHITECTURE.md §5–6, MODULES.md) that this module fixes:
 * - `minKeep` counts candidate units — units that are neither pinned nor duplicate ("units that
 *   always survive (after pins)"). Pins never count toward it and are never touched by it, so the
 *   compacted context always carries at least `min(minKeep, candidates)` judged units.
 * - When `answers` is undefined (Jev unavailable, or nothing to judge) no unit is dropped at all.
 *   The budget pass is Jev's last resort, not a substitute for Jev; fail-open returns the originals.
 */
import type { JevAnswers } from './jev.js';
import { pendingUnit } from './normalize.js';
import type { PrepassResult } from './prepass.js';
import type {
  AnyMessage,
  Decision,
  ForemanFinding,
  ForemanKind,
  MessageFormat,
  ResolvedOptions,
  Unit,
  UnitReport,
} from './types.js';

export interface DecideResult {
  /** One report per unit, in unit order. */
  reports: UnitReport[];
  /** Ids of the units that survive: `kept`, `pinned` and `flagged`. Insertion order = unit order. */
  keptIds: Set<string>;
  /** `foremanLevels(answers?.foreman, pre.findings, opts, pendingUnit(units)?.indices)`. */
  foreman: ForemanFinding[];
  /** Jev progress score 0–2, when judged. */
  progress?: number;
}

/** Absorbs binary-float noise at the thresholds (`1 - 0.55` is `0.44999999999999996`). */
const EPSILON = 1e-9;

const FOREMAN_KINDS: readonly ForemanKind[] = [
  'destructive',
  'exfiltration',
  'thrashing',
  'goal_drift',
];

function survives(decision: Decision): boolean {
  return decision === 'kept' || decision === 'pinned' || decision === 'flagged';
}

/** `1 - pKeep ≥ threshold`, i.e. P(drop) at or above the threshold. */
function dropAt(pKeep: number, threshold: number): boolean {
  return 1 - pKeep >= threshold - EPSILON;
}

function fmt(p: number): string {
  return p.toFixed(2);
}

function initialReport(
  unit: Unit,
  pre: PrepassResult,
  answers: JevAnswers | undefined,
  opts: ResolvedOptions,
): UnitReport {
  const base = { unit: unit.id, indices: [...unit.indices], tokens: unit.tokens };
  const pinReason = pre.pinned.get(unit.id);
  if (pinReason !== undefined) return { ...base, decision: 'pinned', reason: pinReason };
  const dupReason = pre.duplicates.get(unit.id);
  if (dupReason !== undefined) return { ...base, decision: 'duplicate', reason: dupReason };
  if (answers === undefined) return { ...base, decision: 'kept', reason: 'jev:unavailable' };
  const judged = answers.units.get(unit.id);
  if (judged === undefined || !Number.isFinite(judged.pKeep)) {
    return { ...base, decision: 'kept', reason: 'unjudged' };
  }
  const { pKeep, confidence } = judged;
  if (dropAt(pKeep, opts.dropThreshold)) {
    return {
      ...base,
      decision: 'dropped',
      pKeep,
      confidence,
      reason: `jev:drop p=${fmt(1 - pKeep)}`,
    };
  }
  return { ...base, decision: 'kept', pKeep, confidence, reason: `jev:keep p=${fmt(pKeep)}` };
}

/**
 * Per unit: pinned → `pinned`; duplicate → `duplicate`; judged with `1 - pKeep ≥ dropThreshold` →
 * `dropped`; judged otherwise, unjudged, or no answers → `kept`. Then `minKeep` re-keeps the newest
 * dropped candidates, then the budget: while Σ kept tokens > `maxTokens`, drop judged-kept
 * candidates in order of lowest P(keep) first (oldest first on ties) — Jev's probabilities decide
 * what goes, position only breaks ties. A drop at or above `dropThresholdSecondPass` is reported as
 * `jev:drop-2nd-pass`, below it as `budget`. Never a pin, never a unit Jev did not see (an unjudged
 * unit is kept, never silently dropped: every drop carries Jev's probability), never below `minKeep`. Finally,
 * units implicated in an action-level finding are `flagged` (still kept).
 */
export function decide(
  units: Unit[],
  pre: PrepassResult,
  answers: JevAnswers | undefined,
  opts: ResolvedOptions,
): DecideResult {
  const reports = units.map((unit) => initialReport(unit, pre, answers, opts));
  // Same objects as in `reports`, so every mutation below is visible there. Oldest first.
  const candidates = reports.filter((r) => r.decision !== 'pinned' && r.decision !== 'duplicate');
  const minKeep = Math.max(0, Math.floor(opts.minKeep));

  if (answers !== undefined) {
    let keptCandidates = candidates.filter((r) => survives(r.decision)).length;

    // minKeep: re-keep the newest dropped candidates.
    for (let i = candidates.length - 1; i >= 0 && keptCandidates < minKeep; i--) {
      const r = candidates[i];
      if (r === undefined || r.decision !== 'dropped') continue;
      r.decision = 'kept';
      r.reason = `minKeep (was ${r.reason})`;
      keptCandidates++;
    }

    // Budget: still over maxTokens? Drop judged-kept candidates lowest P(keep) first, oldest first on
    // ties. Units at or above the second-pass threshold go as `jev:drop-2nd-pass` (they always sort
    // first), the rest as `budget`. Only units Jev judged: an unjudged unit (omitted from the state,
    // or in a failed batch) stays.
    let keptTokens = 0;
    for (const r of reports) if (survives(r.decision)) keptTokens += r.tokens;
    const droppable = candidates
      .map((r, position) => ({ r, position }))
      .filter(({ r }) => r.decision === 'kept' && r.pKeep !== undefined)
      .sort((a, b) => (a.r.pKeep ?? 0) - (b.r.pKeep ?? 0) || a.position - b.position);
    for (const { r } of droppable) {
      if (keptTokens <= opts.maxTokens || keptCandidates <= minKeep) break;
      const secondPass = dropAt(r.pKeep ?? 0, opts.dropThresholdSecondPass);
      r.decision = secondPass ? 'dropped' : 'budget';
      r.reason = secondPass ? 'jev:drop-2nd-pass' : 'budget';
      keptTokens -= r.tokens;
      keptCandidates--;
    }
  }

  // Flag the kept units implicated (by message index) in an action-level finding.
  const foreman = foremanLevels(answers?.foreman, pre.findings, opts, pendingUnit(units)?.indices);
  const implicated = new Map<number, ForemanFinding>();
  for (const finding of foreman) {
    if (finding.level !== 'action') continue;
    for (const index of finding.indices) if (!implicated.has(index)) implicated.set(index, finding);
  }
  if (implicated.size > 0) {
    for (const r of reports) {
      if (!survives(r.decision)) continue;
      const index = r.indices.find((i) => implicated.has(i));
      const finding = index === undefined ? undefined : implicated.get(index);
      if (finding === undefined) continue;
      const evidence = finding.evidence === undefined ? '' : ` ${finding.evidence}`;
      r.reason = `flagged:${finding.kind}${evidence} (was ${r.reason})`;
      r.decision = 'flagged';
    }
  }

  const keptIds = new Set<string>();
  for (const r of reports) if (survives(r.decision)) keptIds.add(r.unit);

  const result: DecideResult = { reports, keptIds, foreman };
  const progress = answers?.progress;
  if (progress !== undefined) result.progress = progress;
  return result;
}

/**
 * Pattern findings pass through unchanged. Each noul at/above `actionThreshold` becomes a Jev
 * `action` finding, at/above `reviewThreshold` a `review` finding, below that nothing. Jev's
 * `destructive`/`exfiltration` nouls are asked about the pending action when there is one (see
 * `pendingUnit`), so those findings carry `pendingIndices`; thrashing/goal_drift are whole-state and
 * carry none. Sorted action first, then probability descending (stable, so the regex floor leads
 * ties).
 */
export function foremanLevels(
  nouls: Record<ForemanKind, number> | undefined,
  patternFindings: ForemanFinding[],
  opts: Pick<ResolvedOptions, 'reviewThreshold' | 'actionThreshold'>,
  pendingIndices: readonly number[] = [],
): ForemanFinding[] {
  const findings: ForemanFinding[] = [...patternFindings];
  if (nouls !== undefined) {
    for (const kind of FOREMAN_KINDS) {
      const probability: unknown = nouls[kind];
      if (typeof probability !== 'number' || !Number.isFinite(probability)) continue;
      const indices = isGated(kind) ? [...pendingIndices] : [];
      if (probability >= opts.actionThreshold - EPSILON) {
        findings.push({ kind, source: 'jev', probability, level: 'action', indices });
      } else if (probability >= opts.reviewThreshold - EPSILON) {
        findings.push({ kind, source: 'jev', probability, level: 'review', indices });
      }
    }
  }
  const rank = (f: ForemanFinding): number => (f.level === 'action' ? 0 : 1);
  return findings.sort((a, b) => rank(a) - rank(b) || b.probability - a.probability);
}

/** The two kinds safety gating blocks on; thrashing and goal drift steer via the corrective prompt. */
function isGated(kind: ForemanKind): boolean {
  return kind === 'destructive' || kind === 'exfiltration';
}

/**
 * The finding that blocks a safety-gated run: the first action-level `destructive`/`exfiltration`
 * finding that implicates the pending action — `pendingIndices` being the agent-authored frames of
 * `pendingUnit` (see `actionIndices`). Thrashing and goal drift never block (they inject the
 * corrective prompt), and a finding about anything else — a proposal the user already rejected, the
 * user's own warning, a command a tool result merely quotes — is reported and flagged but does not
 * block. `undefined` when nothing is pending or nothing implicates it.
 */
export function blockingFinding(
  findings: readonly ForemanFinding[],
  pendingIndices: readonly number[],
): ForemanFinding | undefined {
  if (pendingIndices.length === 0) return undefined;
  const pending = new Set(pendingIndices);
  return findings.find(
    (f) => f.level === 'action' && isGated(f.kind) && f.indices.some((i) => pending.has(i)),
  );
}

export const DEFAULT_CORRECTIVE: Readonly<Record<'thrashing' | 'goal_drift', string>> = {
  thrashing:
    'Compaction notice: you have repeated the same failed action without progress. Stop, state what you have tried and why it failed, and choose a different approach before acting again.',
  goal_drift:
    'Compaction notice: your recent turns drifted from the goal "{goal}". Return to the goal or explain why the detour is necessary.',
};

/**
 * Joins (with a blank line) the templates for every action-level Jev `thrashing`/`goal_drift`
 * finding, one per kind in finding order, with `{goal}` substituted. `undefined` when
 * `correctivePrompts` is `false` or nothing qualifies.
 */
export function correctivePrompt(
  findings: ForemanFinding[],
  goal: string,
  opts: ResolvedOptions,
): string | undefined {
  const templates = opts.correctivePrompts;
  if (templates === false) return undefined;
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    if (finding.source !== 'jev' || finding.level !== 'action') continue;
    if (finding.kind !== 'thrashing' && finding.kind !== 'goal_drift') continue;
    if (seen.has(finding.kind)) continue;
    seen.add(finding.kind);
    const template = templates[finding.kind] ?? DEFAULT_CORRECTIVE[finding.kind];
    // A replacer function keeps `$&`-style patterns in the goal literal.
    parts.push(template.replaceAll('{goal}', () => goal));
  }
  return parts.length === 0 ? undefined : parts.join('\n\n');
}

/**
 * `messages.filter((_, i) => keptIndex.has(i))`: the same object references, in the original
 * order. An addendum is appended as `{role:'system'}` (openai/plain) or `{type:'system'}`
 * (langchain); for anthropic, whose `system` lives outside the array, it comes back as
 * `systemAddendum` instead.
 */
export function reassemble<M extends AnyMessage>(
  messages: readonly M[],
  units: Unit[],
  keptIds: ReadonlySet<string>,
  format: MessageFormat,
  addendum?: string,
): { messages: M[]; systemAddendum?: string } {
  const keptIndex = new Set<number>();
  for (const unit of units) {
    if (!keptIds.has(unit.id)) continue;
    for (const index of unit.indices) keptIndex.add(index);
  }
  const kept = messages.filter((_, i) => keptIndex.has(i));
  if (addendum === undefined || addendum === '') return { messages: kept };
  if (format === 'anthropic') return { messages: kept, systemAddendum: addendum };
  const system: AnyMessage =
    format === 'langchain'
      ? { type: 'system', content: addendum }
      : { role: 'system', content: addendum };
  kept.push(system as M);
  return { messages: kept };
}
