/**
 * The engine: `compact()` runs the pipeline from ARCHITECTURE.md end to end — normalize → pre-pass
 * → skeleton → Jev → decide → reassemble → report — and applies the trigger, fail-open/fail-closed
 * and safety-gating policies. Jev judges relevance; everything here is code that decides structure
 * and runs whether or not Jev is available or right. The caller's messages are only ever read;
 * every kept message is the same object that came in.
 */
import type { TypeSafeClient } from '@typesafe-ai/sdk';
import { TypeSafeError } from '@typesafe-ai/sdk';
import {
  blockingFinding,
  correctivePrompt,
  DEFAULT_CORRECTIVE,
  decide,
  reassemble,
} from './decide.js';
import { askJev, createClient, isAbortError, type JevAnswers, StateTooLargeError } from './jev.js';
import { actionIndices, defaultGoal, groupUnits, normalize, pendingUnit } from './normalize.js';
import { DEFAULT_PATTERNS, prepass, scanPatterns } from './prepass.js';
import { buildSkeleton, MAX_STAGE } from './skeleton.js';
import { estimateTokens, messageTokens } from './tokens.js';
import {
  type AnyMessage,
  type CompactionReport,
  type CompactionResult,
  CompactionUnavailableError,
  type CompactOptions,
  type EscrowVerdict,
  type ForemanFinding,
  type ForemanPattern,
  type Frame,
  type GoalOption,
  type JevTelemetry,
  type MessageFormat,
  type ResolvedOptions,
  type SkipReason,
  type Unit,
  type UnitReport,
} from './types.js';

// ───────────────────────────── defaults ─────────────────────────────

/**
 * Every numeric and boolean default from the `CompactOptions` comments in types.ts. `trigger`
 * depends on the entry point (`always` for `compact()`, `auto` for `withCompaction()`) and is
 * resolved by `resolveOptions`; `cooldownTurns` is used by `withCompaction` only.
 */
export const DEFAULTS = Object.freeze({
  maxTokens: 15_000,
  keepRecent: 4,
  pinCodeWithin: 12,
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
  failClosed: false,
  timeoutMs: 10_000,
  cooldownTurns: 1,
});

export type CompactionMode = 'compact' | 'wrap';

function resolvePatterns(patterns: CompactOptions['patterns']): readonly ForemanPattern[] {
  if (patterns === undefined) return DEFAULT_PATTERNS;
  if (typeof patterns === 'function') return patterns(DEFAULT_PATTERNS);
  return patterns;
}

function resolveCorrective(
  templates: CompactOptions['correctivePrompts'],
): ResolvedOptions['correctivePrompts'] {
  if (templates === false) return false;
  const merged: Record<'thrashing' | 'goal_drift', string> = { ...DEFAULT_CORRECTIVE };
  if (templates !== undefined) {
    // A JavaScript caller may pass an explicit `undefined`; only strings override a default.
    if (typeof templates.thrashing === 'string') merged.thrashing = templates.thrashing;
    if (typeof templates.goal_drift === 'string') merged.goal_drift = templates.goal_drift;
  }
  return merged;
}

/**
 * Applies every default. `trigger` defaults to `always` in `compact` mode and `auto` in `wrap`
 * mode; a `patterns` function receives `DEFAULT_PATTERNS`; `correctivePrompts` merges over
 * `DEFAULT_CORRECTIVE`; `countTokens` defaults to the chars/2.5 heuristic.
 */
export function resolveOptions(
  options: CompactOptions | undefined,
  mode: CompactionMode,
): ResolvedOptions {
  const o: CompactOptions = options ?? {};
  return {
    goal: o.goal,
    maxTokens: o.maxTokens ?? DEFAULTS.maxTokens,
    trigger: o.trigger ?? (mode === 'compact' ? 'always' : 'auto'),
    keepRecent: o.keepRecent ?? DEFAULTS.keepRecent,
    pinCodeWithin: o.pinCodeWithin ?? DEFAULTS.pinCodeWithin,
    pin: o.pin,
    dropThreshold: o.dropThreshold ?? DEFAULTS.dropThreshold,
    dropThresholdSecondPass: o.dropThresholdSecondPass ?? DEFAULTS.dropThresholdSecondPass,
    minKeep: o.minKeep ?? DEFAULTS.minKeep,
    allowTruncate: o.allowTruncate ?? DEFAULTS.allowTruncate,
    truncateHeadChars: o.truncateHeadChars ?? DEFAULTS.truncateHeadChars,
    excerptChars: o.excerptChars ?? DEFAULTS.excerptChars,
    stateTokens: o.stateTokens ?? DEFAULTS.stateTokens,
    requestTokens: o.requestTokens ?? DEFAULTS.requestTokens,
    concurrency: o.concurrency ?? DEFAULTS.concurrency,
    safetyGating: o.safetyGating ?? DEFAULTS.safetyGating,
    reviewThreshold: o.reviewThreshold ?? DEFAULTS.reviewThreshold,
    actionThreshold: o.actionThreshold ?? DEFAULTS.actionThreshold,
    patterns: resolvePatterns(o.patterns),
    correctivePrompts: resolveCorrective(o.correctivePrompts),
    failClosed: o.failClosed ?? DEFAULTS.failClosed,
    countTokens: o.countTokens ?? estimateTokens,
    format: o.format ?? 'auto',
    client: o.client,
    apiKey: o.apiKey,
    model: o.model,
    baseURL: o.baseURL,
    timeoutMs: o.timeoutMs ?? DEFAULTS.timeoutMs,
    signal: o.signal,
    onReport: o.onReport,
    onEscrow: o.onEscrow,
  };
}

// ───────────────────────────── errors ─────────────────────────────

/**
 * Names of the SDK's error classes, so an error from a second copy of the SDK (or a look-alike
 * thrown by an injected client) is still treated as "Jev unavailable" rather than a bug. A caller's
 * abort (`APIUserAbortError`) is checked before this and propagates instead.
 */
const JEV_ERROR_NAMES: ReadonlySet<string> = new Set([
  'TypeSafeError',
  'APIError',
  'APIConnectionError',
  'APITimeoutError',
  'AuthenticationError',
  'BadRequestError',
  'PermissionDeniedError',
  'NotFoundError',
  'UnprocessableEntityError',
  'RateLimitError',
  'InternalServerError',
  'StateTooLargeError',
]);

/** Any Jev/network failure, including a missing key and a state Jev refuses at every stage. */
function isJevError(error: unknown): boolean {
  if (error instanceof TypeSafeError || error instanceof StateTooLargeError) return true;
  return error instanceof Error && JEV_ERROR_NAMES.has(error.name);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ───────────────────────────── pipeline ─────────────────────────────

/** Everything the pure front half of the pipeline produced, shared by every exit path. */
interface Run<M extends AnyMessage> {
  readonly input: readonly M[];
  readonly opts: ResolvedOptions;
  readonly started: number;
  readonly format: MessageFormat;
  readonly goal: string;
  readonly units: Unit[];
  /** The agent's pending action (see `pendingUnit`): what safety gating blocks on. */
  readonly pending: Unit | undefined;
  readonly tokensBefore: number;
  /** Original object → its token estimate, so `tokensAfter` never re-counts a kept message. */
  readonly tokensOf: ReadonlyMap<AnyMessage, number>;
}

function resolveGoal(
  goal: GoalOption | undefined,
  messages: AnyMessage[],
  frames: Frame[],
): string {
  if (typeof goal === 'string') return goal;
  if (typeof goal === 'function') return goal(messages, frames);
  return defaultGoal(frames);
}

function prepare<M extends AnyMessage>(
  input: readonly M[],
  opts: ResolvedOptions,
  started: number,
): Run<M> {
  const messages: AnyMessage[] = [...input];
  const { format, frames } = normalize(messages, opts.format, opts.pin);
  // normalize.ts always estimates with the default heuristic; a caller-supplied counter (tiktoken,
  // a provider's count endpoint) is applied here, before the frames are grouped into units.
  if (opts.countTokens !== estimateTokens) {
    for (const frame of frames) {
      const original = messages[frame.index];
      if (original !== undefined) frame.tokens = messageTokens(original, opts.countTokens);
    }
  }
  const goal = resolveGoal(opts.goal, messages, frames);
  const units = groupUnits(frames);
  const tokensOf = new Map<AnyMessage, number>();
  let tokensBefore = 0;
  for (const frame of frames) {
    tokensBefore += frame.tokens;
    const original = messages[frame.index];
    if (original !== undefined) tokensOf.set(original, frame.tokens);
  }
  return {
    input,
    opts,
    started,
    format,
    goal,
    units,
    pending: pendingUnit(units),
    tokensBefore,
    tokensOf,
  };
}

/** After a size rejection, the next build aims at this fraction of the state Jev just refused. */
const RETRY_SHRINK = 0.6;
/** Upper bound on Jev round trips for one compaction while the state keeps being rejected. */
const MAX_LADDER_ATTEMPTS = 8;

/**
 * Builds the skeleton and asks Jev, rebuilding whenever Jev rejects the state as too large: one
 * abridging stage further (up to `MAX_STAGE`) and against a tighter `stateTokens`. The tightening
 * matters because Jev tokenizes some text (CJK, dense JSON) far denser than the 2.5 chars/token
 * estimate the stages fit against; without it stage 5 would omit nothing (the estimate says the
 * state fits) and the same state would be rejected forever. The ladder stops when a rebuild is no
 * smaller than the last rejected one or after `MAX_LADDER_ATTEMPTS`, and the final telemetry counts
 * every request the ladder made. Any other failure propagates to the policy below.
 */
async function judge(
  units: Unit[],
  candidates: readonly Unit[],
  goal: string,
  opts: ResolvedOptions,
  client: TypeSafeClient,
  pendingId: string | undefined,
): Promise<JevAnswers> {
  const candidateIds = new Set(candidates.map((u) => u.id));
  const started = Date.now();
  let minStage = 0;
  let stateTokens = opts.stateTokens;
  let priorRequests = 0;
  const priorIds: string[] = [];
  let last: { tokens: number; error: StateTooLargeError } | undefined;
  for (let attempt = 0; attempt < MAX_LADDER_ATTEMPTS; attempt++) {
    const budgeted = stateTokens === opts.stateTokens ? opts : { ...opts, stateTokens };
    const skeleton = buildSkeleton(units, candidateIds, goal, budgeted, minStage);
    // Nothing left to omit: a rebuild that is no smaller would only be rejected again.
    if (last !== undefined && skeleton.tokens >= last.tokens) throw last.error;
    try {
      const answers = await askJev(skeleton, candidates, opts, client, pendingId);
      if (priorRequests > 0) {
        const t = answers.telemetry;
        t.requests += priorRequests;
        t.requestIds = [...priorIds, ...t.requestIds];
        t.latencyMs = Date.now() - started;
      }
      return answers;
    } catch (error: unknown) {
      if (!(error instanceof StateTooLargeError)) throw error;
      priorRequests += error.requests;
      priorIds.push(...error.requestIds);
      last = { tokens: skeleton.tokens, error };
      stateTokens = Math.max(1, Math.floor(Math.min(stateTokens, skeleton.tokens) * RETRY_SHRINK));
      minStage = Math.min(MAX_STAGE, Math.max(minStage, error.stage, skeleton.fitStage) + 1);
    }
  }
  if (last === undefined) throw new Error('judge: the ladder made no attempt');
  throw last.error;
}

/**
 * Fail-open hands every original back, so no unit report may claim a drop. `decide` without
 * answers still marks exact duplicates; they become `kept` (or `flagged` when a pattern finding
 * implicates them), with the original reason preserved.
 */
function keepEverything(reports: UnitReport[], foreman: ForemanFinding[]): void {
  const implicated = new Map<number, ForemanFinding>();
  for (const finding of foreman) {
    if (finding.level !== 'action') continue;
    for (const index of finding.indices) if (!implicated.has(index)) implicated.set(index, finding);
  }
  for (const report of reports) {
    if (report.decision !== 'duplicate') continue;
    const reason = `jev:unavailable (was ${report.reason})`;
    const index = report.indices.find((i) => implicated.has(i));
    const finding = index === undefined ? undefined : implicated.get(index);
    if (finding === undefined) {
      report.decision = 'kept';
      report.reason = reason;
    } else {
      const evidence = finding.evidence === undefined ? '' : ` ${finding.evidence}`;
      report.decision = 'flagged';
      report.reason = `flagged:${finding.kind}${evidence} (was ${reason})`;
    }
  }
}

/** What one exit path of the pipeline produced; `finish` turns it into the result. */
interface Outcome<M> {
  messages: M[];
  units: UnitReport[];
  foreman: ForemanFinding[];
  skipped?: SkipReason;
  error?: string;
  progress?: number;
  jev?: JevTelemetry;
  systemAddendum?: string;
}

/**
 * Builds the report and the result, then applies safety gating: `blocked` when an action-level
 * destructive/exfiltration finding implicates what the agent proposed or did in the pending action
 * (`blockingFinding` over its agent-authored frames), unless `onEscrow` approves. An escrow hook
 * that throws cannot approve, so the block stands.
 */
async function finish<M extends AnyMessage>(
  run: Run<M>,
  out: Outcome<M>,
): Promise<CompactionResult<M>> {
  const { opts } = run;
  let tokensAfter = 0;
  for (const message of out.messages) {
    tokensAfter += run.tokensOf.get(message) ?? messageTokens(message, opts.countTokens);
  }
  const report: CompactionReport = {
    goal: run.goal,
    format: run.format,
    tokensBefore: run.tokensBefore,
    tokensAfter,
    messagesBefore: run.input.length,
    messagesAfter: out.messages.length,
    units: out.units,
    foreman: out.foreman,
    latencyMs: Date.now() - run.started,
  };
  if (out.progress !== undefined) report.progress = out.progress;
  if (out.jev !== undefined) report.jev = out.jev;
  if (out.skipped !== undefined) report.skipped = out.skipped;
  if (out.error !== undefined) report.error = out.error;
  opts.onReport?.(report);

  const result: CompactionResult<M> = {
    messages: out.messages,
    report,
    blocked: false,
    compacted: out.skipped === undefined,
  };
  if (out.systemAddendum !== undefined) result.systemAddendum = out.systemAddendum;

  if (opts.safetyGating) {
    const action = blockingFinding(
      out.foreman,
      run.pending === undefined ? [] : actionIndices(run.pending),
    );
    if (action !== undefined) {
      result.blocked = true;
      if (opts.onEscrow !== undefined) {
        let verdict: EscrowVerdict = 'block';
        try {
          verdict = await opts.onEscrow(action, result);
        } catch {
          // An escrow that cannot answer cannot approve.
        }
        if (verdict === 'approve') result.blocked = false;
      }
    }
  }
  return result;
}

/**
 * A run that never reaches Jev — below the `auto` trigger, or in the wrapper's cooldown — still
 * runs the regex Foreman over the whole history (code-level and unconditional), so safety gating
 * holds on every call and the findings are reported. No unit is judged: the input comes back as is.
 */
function floorOnly<M extends AnyMessage>(
  run: Run<M>,
  skipped: 'below_threshold' | 'cooldown',
): Promise<CompactionResult<M>> {
  return finish(run, {
    messages: [...run.input],
    units: [],
    foreman: scanPatterns(run.units, run.opts.patterns),
    skipped,
  });
}

/** The wrapper's cooldown skip: no Jev, but the regex floor, the report and safety gating. */
export function skipCompaction<M extends AnyMessage>(
  messages: readonly M[],
  opts: ResolvedOptions,
  reason: 'cooldown',
): Promise<CompactionResult<M>> {
  return floorOnly(prepare(messages, opts, Date.now()), reason);
}

async function execute<M extends AnyMessage>(
  input: readonly M[],
  opts: ResolvedOptions,
  getClient: () => TypeSafeClient,
): Promise<CompactionResult<M>> {
  const run = prepare(input, opts, Date.now());

  if (opts.trigger === 'auto' && run.tokensBefore <= opts.maxTokens) {
    return floorOnly(run, 'below_threshold');
  }

  const pre = prepass(run.units, run.goal, opts);

  if (pre.candidates.length === 0 && !opts.safetyGating) {
    // Nothing for Jev to judge and no Foreman wanted: pins, dedup and the regex floor still apply.
    const decided = decide(run.units, pre, undefined, opts);
    const { messages } = reassemble(input, run.units, decided.keptIds, run.format);
    return finish(run, {
      messages,
      units: decided.reports,
      foreman: decided.foreman,
      skipped: 'nothing_to_judge',
    });
  }

  let answers: JevAnswers | undefined;
  let error: string | undefined;
  try {
    // The client is created here so a missing key is a Jev failure, subject to the same policy.
    answers = await judge(run.units, pre.candidates, run.goal, opts, getClient(), run.pending?.id);
  } catch (caught: unknown) {
    // A cancellation is the caller's own: it propagates as is, never as "Jev unavailable".
    if (isAbortError(caught) || opts.signal?.aborted === true) throw caught;
    if (!isJevError(caught)) throw caught;
    if (opts.failClosed) {
      throw new CompactionUnavailableError(`Jev unavailable: ${messageOf(caught)}`, {
        cause: caught,
      });
    }
    error = messageOf(caught);
  }

  if (answers === undefined) {
    // Fail-open: the originals go back untouched; only the regex Foreman and the report remain.
    const decided = decide(run.units, pre, undefined, opts);
    keepEverything(decided.reports, decided.foreman);
    const out: Outcome<M> = {
      messages: [...input],
      units: decided.reports,
      foreman: decided.foreman,
      skipped: 'jev_unavailable',
    };
    if (error !== undefined) out.error = error;
    return finish(run, out);
  }

  const decided = decide(run.units, pre, answers, opts);
  const addendum = correctivePrompt(decided.foreman, run.goal, opts);
  const assembled = reassemble(input, run.units, decided.keptIds, run.format, addendum);
  const out: Outcome<M> = {
    messages: assembled.messages,
    units: decided.reports,
    foreman: decided.foreman,
    jev: answers.telemetry,
  };
  if (decided.progress !== undefined) out.progress = decided.progress;
  if (assembled.systemAddendum !== undefined) out.systemAddendum = assembled.systemAddendum;
  return finish(run, out);
}

// ───────────────────────────── public entry points ─────────────────────────────

/**
 * Compacts `messages` for `options.goal` and returns the kept originals with a full report.
 * `trigger` defaults to `always` here. Jev failures fail open (the input comes back unchanged,
 * `report.skipped = 'jev_unavailable'`) unless `failClosed` is set; a caller's abort rejects.
 */
export async function compact<M extends AnyMessage>(
  messages: readonly M[],
  options?: CompactOptions,
): Promise<CompactionResult<M>> {
  const opts = resolveOptions(options, 'compact');
  return execute(messages, opts, () => createClient(opts));
}

export interface Compactor {
  compact<M extends AnyMessage>(
    messages: readonly M[],
    overrides?: CompactOptions,
  ): Promise<CompactionResult<M>>;
  readonly options: ResolvedOptions;
  /** Created lazily on first use (or first access), then shared by every call. */
  readonly client: TypeSafeClient;
}

/** Option keys that determine which client a call needs. */
const CLIENT_KEYS = ['client', 'apiKey', 'model', 'baseURL', 'timeoutMs'] as const;

/** `base` with every defined key of `overrides` on top; explicit `undefined` never clobbers. */
function mergeOptions(base: CompactOptions | undefined, overrides: CompactOptions): CompactOptions {
  const merged: Record<string, unknown> = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as unknown as CompactOptions;
}

/**
 * A reusable compactor. The mode sets the `trigger` default: `compact` for `createCompactor`,
 * `wrap` for `withCompaction`. Per-call overrides are merged over the original options; a call
 * that overrides a client setting gets its own client, every other call shares the lazy one.
 */
export function makeCompactor(
  options: CompactOptions | undefined,
  mode: CompactionMode,
): Compactor {
  const base = resolveOptions(options, mode);
  let shared: TypeSafeClient | undefined;
  const getShared = (): TypeSafeClient => {
    shared ??= createClient(base);
    return shared;
  };
  return {
    options: base,
    get client(): TypeSafeClient {
      return getShared();
    },
    compact(messages, overrides) {
      if (overrides === undefined) return execute(messages, base, getShared);
      const opts = resolveOptions(mergeOptions(options, overrides), mode);
      const ownClient = CLIENT_KEYS.some((key) => overrides[key] !== undefined);
      return execute(messages, opts, ownClient ? () => createClient(opts) : getShared);
    },
  };
}

/** A reusable compactor with `trigger: 'always'` by default; the client is created once, lazily. */
export function createCompactor(options?: CompactOptions): Compactor {
  return makeCompactor(options, 'compact');
}
