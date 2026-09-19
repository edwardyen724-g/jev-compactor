/**
 * The one network module: builds the per-candidate keep/drop questions and the Foreman set,
 * batches them under the request budget, fans the batches out to Jev with bounded concurrency,
 * and folds the typed answers into `JevAnswers`. Everything structural (pins, dedup, thresholds,
 * budgets) lives in code elsewhere; this module only asks and collects.
 */
import {
  APIUserAbortError,
  BadRequestError,
  type ChoiceQuestion,
  choice,
  type EntryType,
  type NoulQuestion,
  noul,
  type Questions,
  type RequestOptions,
  type ScoreQuestion,
  type SystemOneResult,
  score,
  TypeSafeClient,
  type TypeSafeClientConfig,
} from '@typesafe-ai/sdk';
import { estimateTokens } from './tokens.js';
import {
  CompactionError,
  type ForemanKind,
  type JevTelemetry,
  type ResolvedOptions,
  type Skeleton,
  type Unit,
} from './types.js';

// ───────────────────────────── errors ─────────────────────────────

/** Jev's state limit is 32k tokens for state + longest question (HTTP 400 `max_tokens_exceeded`). */
export const JEV_STATE_LIMIT_TOKENS = 32_000;

/** Price per input token in USD ($0.042 per million; output is free). */
export const USD_PER_INPUT_TOKEN = 0.042 / 1e6;

export interface StateTooLargeOptions extends ErrorOptions {
  /** Requests the rejected attempt sent, and the request ids it got back, for telemetry. */
  requests?: number;
  requestIds?: readonly string[];
}

/**
 * Thrown when Jev rejects the state as too large (HTTP 400 `error_type === 'max_tokens_exceeded'`).
 * Carries the abridging `stage` the skeleton was built at so the engine can rebuild one stage
 * further (and tighter) and retry, plus what the attempt cost so the final telemetry can include it.
 */
export class StateTooLargeError extends CompactionError {
  override name = 'StateTooLargeError';
  readonly requests: number;
  readonly requestIds: readonly string[];
  constructor(
    message: string,
    public readonly stage: number,
    options?: StateTooLargeOptions,
  ) {
    super(message, options);
    this.requests = options?.requests ?? 0;
    this.requestIds = options?.requestIds ?? [];
  }
}

/**
 * HTTP 400 `max_tokens_exceeded`. Recognized by class for this package's SDK copy and by name or
 * status for an injected client built from another copy, so the re-abridge ladder runs either way.
 */
function isMaxTokensExceeded(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { status, body } = error as Error & { status?: unknown; body?: unknown };
  const badRequest =
    error instanceof BadRequestError || error.name === 'BadRequestError' || status === 400;
  if (!badRequest || typeof body !== 'object' || body === null) return false;
  const detail: unknown = (body as Record<string, unknown>).detail;
  if (typeof detail !== 'object' || detail === null) return false;
  return (detail as Record<string, unknown>).error_type === 'max_tokens_exceeded';
}

/** The caller cancelled through `options.signal`: propagated as is, never "Jev unavailable". */
export function isAbortError(error: unknown): boolean {
  if (error instanceof APIUserAbortError) return true;
  return (
    error instanceof Error && (error.name === 'APIUserAbortError' || error.name === 'AbortError')
  );
}

// ───────────────────────────── client ─────────────────────────────

/**
 * The injected client, or a new one from `apiKey`/`baseURL`/`model`/`timeoutMs`. Undefined keys
 * are omitted so the SDK falls back to its `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL` and
 * `TYPESAFE_DEFAULT_MODEL` (then `jev-latest`). `logLevel` is pinned to `warn`: `debug` logs request
 * bodies, so `TYPESAFE_LOG_LEVEL` is deliberately not honored here.
 */
export function createClient(opts: ResolvedOptions): TypeSafeClient {
  if (opts.client !== undefined) return opts.client;
  const config: TypeSafeClientConfig = { timeout: opts.timeoutMs, logLevel: 'warn' };
  if (opts.model !== undefined) config.defaultModel = opts.model;
  if (opts.apiKey !== undefined) config.apiKey = opts.apiKey;
  if (opts.baseURL !== undefined) config.baseURL = opts.baseURL;
  return new TypeSafeClient(config);
}

// ───────────────────────────── questions ─────────────────────────────

/**
 * Rich keep/drop criteria. On the probe these separated keep from drop at 0.96 vs ≤ 0.05, where
 * bare `[KEEP, DROP]` labels managed only 0.78 vs ≤ 0.15 (see ARCHITECTURE.md §4).
 */
export const KEEP_CRITERIA = {
  keep: 'It contains facts, code, file contents, error details, or decisions the agent will still need to reach goal, or it is the most recent statement of a fact that later messages depend on.',
  drop: 'It is off-topic, a pleasantry, an exact or near duplicate of another message, or its information has been fully superseded by a later message.',
} as const;

export type CandidateQuestion = ChoiceQuestion<typeof KEEP_CRITERIA>;

/** The keep/drop question for the skeleton entry at `messages[position]`. */
export function candidateQuestion(position: number): CandidateQuestion {
  return choice(
    `Should \`messages[${position}]\` stay in the agent's working memory to accomplish \`goal\`?`,
    KEEP_CRITERIA,
  );
}

export const PROGRESS_LEVELS = ['none', 'some', 'nearly done'] as const;

export interface ForemanQuestions {
  destructive: NoulQuestion;
  exfiltration: NoulQuestion;
  thrashing: NoulQuestion;
  goal_drift: NoulQuestion;
  progress: ScoreQuestion<typeof PROGRESS_LEVELS>;
}

/**
 * The Foreman set, asked once per compaction (batch 0 only). With `pendingPosition` — the skeleton
 * index of the agent's pending action, see `pendingUnit` — `destructive` and `exfiltration` are
 * asked about that entry, which is what safety gating blocks on; without one (the newest message is
 * the user's) they are asked about the whole state, for the report. Thrashing, goal drift and
 * progress are always whole-state.
 */
export function foremanQuestions(pendingPosition?: number): ForemanQuestions {
  const subject =
    pendingPosition === undefined ? 'any entry in `messages`' : `\`messages[${pendingPosition}]\``;
  return {
    destructive: noul(
      `Does ${subject} propose or run a destructive or irreversible command (deleting files or directories, force-pushing, resetting history, dropping or truncating tables, wiping disks, killing all processes)?`,
    ),
    exfiltration: noul(
      `Does ${subject} send secrets, API keys, credentials, or private data to an external host or service?`,
    ),
    thrashing: noul(
      'Do the most recent entries in `messages` show the agent repeating the same failed action or the same error without making progress?',
    ),
    goal_drift: noul(
      'Are the most recent assistant entries in `messages` working on something other than `goal`?',
    ),
    progress: score('How much progress toward `goal` do the `messages` show?', PROGRESS_LEVELS),
  };
}

const FOREMAN_KINDS: readonly ForemanKind[] = [
  'destructive',
  'exfiltration',
  'thrashing',
  'goal_drift',
];
const PROGRESS_NAME = 'progress';
const RESERVED_NAMES: ReadonlySet<string> = new Set<string>([...FOREMAN_KINDS, PROGRESS_NAME]);

function isForemanKind(name: string): name is ForemanKind {
  return (FOREMAN_KINDS as readonly string[]).includes(name);
}

// ───────────────────────────── batching ─────────────────────────────

/** One request's worth of questions. `tokens` is the estimate for state + these questions. */
export interface JevBatch {
  questions: Questions;
  tokens: number;
  /** Unit ids asked in this batch (foreman names excluded). */
  candidateIds: string[];
}

function questionTokens(question: Questions[string]): number {
  return estimateTokens(JSON.stringify(question));
}

/**
 * Greedy fill: a batch takes candidates in order while `skeleton.tokens + Σ question tokens` stays
 * within `requestTokens`. The Foreman questions go into batch 0 only; batch 0 exists even with no
 * candidates. Candidates absent from `skeleton.position` (omitted at stage 5) are not asked. A
 * single question that cannot fit even an otherwise empty batch still gets a batch of its own, so
 * the plan always makes progress and Jev's own limit reports the overflow. `pendingId` (the pending
 * action's unit id) scopes the destructive/exfiltration questions to that entry.
 */
export function planBatches(
  skeleton: Skeleton,
  candidates: readonly Unit[],
  requestTokens: number,
  pendingId?: string,
): JevBatch[] {
  const batches: JevBatch[] = [];
  let current: JevBatch = { questions: {}, tokens: skeleton.tokens, candidateIds: [] };
  let currentHasQuestions = false;

  const pendingPosition = pendingId === undefined ? undefined : skeleton.position.get(pendingId);
  for (const [name, question] of Object.entries(foremanQuestions(pendingPosition))) {
    current.questions[name] = question;
    current.tokens += questionTokens(question);
    currentHasQuestions = true;
  }

  for (const unit of candidates) {
    const position = skeleton.position.get(unit.id);
    if (position === undefined) continue;
    const question = candidateQuestion(position);
    const cost = questionTokens(question);
    if (currentHasQuestions && current.tokens + cost > requestTokens) {
      batches.push(current);
      current = { questions: {}, tokens: skeleton.tokens, candidateIds: [] };
      currentHasQuestions = false;
    }
    current.questions[unit.id] = question;
    current.tokens += cost;
    current.candidateIds.push(unit.id);
    currentHasQuestions = true;
  }
  batches.push(current);
  return batches;
}

// ───────────────────────────── answers ─────────────────────────────

export interface JevAnswers {
  /** Unit id → Jev's keep probability and confidence. Units Jev never saw have no entry. */
  units: Map<string, { pKeep: number; confidence: number }>;
  /** Noul probabilities (max across batches; normally batch 0 only). */
  foreman: Record<ForemanKind, number>;
  /** Progress score 0–2, when answered. */
  progress: number | undefined;
  telemetry: JevTelemetry;
}

export type CollectedAnswers = Pick<JevAnswers, 'units' | 'foreman' | 'progress'>;

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Folds the answers of every batch. Candidate answers are the `choice` answers not named after a
 * Foreman question; `pKeep` is `probabilities.keep` (or `1 − probabilities.drop` when only that
 * side is reported). Foreman nouls take the max across batches; `progress` the last score seen.
 */
export function collectAnswers(results: readonly SystemOneResult<Questions>[]): CollectedAnswers {
  const units = new Map<string, { pKeep: number; confidence: number }>();
  const foreman: Record<ForemanKind, number> = {
    destructive: 0,
    exfiltration: 0,
    thrashing: 0,
    goal_drift: 0,
  };
  let progress: number | undefined;

  for (const result of results) {
    for (const [name, answer] of Object.entries(result.answers)) {
      if (answer.type === 'noul') {
        if (isForemanKind(name)) foreman[name] = Math.max(foreman[name], clamp01(answer.noul));
        continue;
      }
      if (answer.type === 'score') {
        if (name === PROGRESS_NAME) progress = answer.score;
        continue;
      }
      if (RESERVED_NAMES.has(name)) continue;
      const keep = answer.probabilities.keep;
      const drop = answer.probabilities.drop;
      let pKeep: number;
      if (keep !== undefined) pKeep = keep;
      else if (drop !== undefined) pKeep = 1 - drop;
      else pKeep = answer.choice === 'keep' ? 1 : 0;
      units.set(name, { pKeep: clamp01(pKeep), confidence: clamp01(answer.confidence) });
    }
  }
  return { units, foreman, progress };
}

/**
 * Averages several votes — the same questions asked in separate requests. A unit's `pKeep` and
 * `confidence` are the mean over the votes that answered it; each Foreman noul is the mean of the
 * votes' values; `progress` is the mean of the scores seen. A single vote is returned as is.
 */
export function averageVotes(votes: readonly CollectedAnswers[]): CollectedAnswers {
  const empty: Record<ForemanKind, number> = {
    destructive: 0,
    exfiltration: 0,
    thrashing: 0,
    goal_drift: 0,
  };
  const first = votes[0];
  if (first === undefined) return { units: new Map(), foreman: empty, progress: undefined };
  if (votes.length === 1) return first;
  const sums = new Map<string, { pKeep: number; confidence: number; n: number }>();
  for (const vote of votes) {
    for (const [id, answer] of vote.units) {
      const sum = sums.get(id) ?? { pKeep: 0, confidence: 0, n: 0 };
      sum.pKeep += answer.pKeep;
      sum.confidence += answer.confidence;
      sum.n += 1;
      sums.set(id, sum);
    }
  }
  const units = new Map<string, { pKeep: number; confidence: number }>();
  for (const [id, sum] of sums) {
    units.set(id, { pKeep: sum.pKeep / sum.n, confidence: sum.confidence / sum.n });
  }
  const foreman = { ...empty };
  for (const kind of Object.keys(foreman) as ForemanKind[]) {
    foreman[kind] = votes.reduce((total, vote) => total + vote.foreman[kind], 0) / votes.length;
  }
  const scores = votes.map((v) => v.progress).filter((p): p is number => p !== undefined);
  const progress =
    scores.length === 0 ? undefined : scores.reduce((a, b) => a + b, 0) / scores.length;
  return { units, foreman, progress };
}

// ───────────────────────────── fan-out ─────────────────────────────

/**
 * `SkeletonState` is a plain JSON-serializable object, but it is declared as an interface and
 * interfaces carry no implicit index signature, so it is not assignable to the SDK's `EntryType`
 * on its own. The shape is JSON by construction (skeleton.ts builds it from strings), so the
 * widening is safe.
 */
function asEntry(state: Skeleton['state']): EntryType {
  return state as unknown as EntryType;
}

interface BatchOutcome {
  result: SystemOneResult<Questions>;
  requestId: string | undefined;
}

function requestIdOf(error: unknown): string | undefined {
  const id: unknown = (error as { requestId?: unknown } | null)?.requestId;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Asks Jev every batch from `planBatches` with at most `opts.concurrency` requests in flight.
 * The same state travels with every batch (Jev evaluates each question in isolation, so batching
 * changes nothing but the number of round trips). Failure policy:
 * - HTTP 400 `max_tokens_exceeded` from any batch: every batch carries the same state, so the run
 *   stops and `StateTooLargeError` (carrying `skeleton.fitStage`) lets the engine re-abridge.
 * - The caller's abort: the run stops and the abort error propagates.
 * - Any other failure of one batch: that batch drops out — its candidates stay unjudged, i.e. kept —
 *   and its siblings finish. The run fails as a whole only when batch 0 failed (it carries the
 *   Foreman, and a missing verdict must not pass for a clean one) or when no batch succeeded.
 */
export async function askJev(
  skeleton: Skeleton,
  candidates: readonly Unit[],
  opts: ResolvedOptions,
  client: TypeSafeClient,
  pendingId?: string,
): Promise<JevAnswers> {
  const batches = planBatches(skeleton, candidates, opts.requestTokens, pendingId);
  const state = asEntry(skeleton.state);
  const votes = Math.max(1, Math.floor(opts.votes));
  /** Every batch `votes` times: identical questions in separate requests, averaged afterwards. */
  const runs = batches.flatMap((batch, b) =>
    Array.from({ length: votes }, (_, vote) => ({ batch, b, vote })),
  );

  // One internal controller: linked to the caller's signal, and tripped by a size rejection so the
  // remaining in-flight batches stop instead of finishing work nobody will read.
  const controller = new AbortController();
  const callerSignal = opts.signal;
  const forwardAbort = (): void => controller.abort(callerSignal?.reason);
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) forwardAbort();
    else callerSignal.addEventListener('abort', forwardAbort, { once: true });
  }
  const requestOptions: RequestOptions = { signal: controller.signal, timeout: opts.timeoutMs };

  const outcomes: (BatchOutcome | undefined)[] = new Array<BatchOutcome | undefined>(
    runs.length,
  ).fill(undefined);
  const failures = new Map<number, unknown>();
  const failedIds: string[] = [];
  let next = 0;
  let sent = 0;
  let sizeError: unknown;
  let abortError: unknown;
  const stopped = (): boolean => sizeError !== undefined || abortError !== undefined;

  const started = Date.now();
  const runBatch = async (index: number): Promise<void> => {
    const run = runs[index];
    if (run === undefined) return;
    const { batch } = run;
    sent += 1;
    try {
      const { data, requestId } = await client
        .systemOne({ state, questions: batch.questions }, requestOptions)
        .withResponse();
      outcomes[index] = { result: data, requestId };
    } catch (error: unknown) {
      const requestId = requestIdOf(error);
      if (requestId !== undefined) failedIds.push(requestId);
      if (isAbortError(error)) {
        // The caller's cancellation ends the run; a sibling cut short by our own controller (after a
        // size rejection) is just collateral and already accounted for.
        if (callerSignal?.aborted === true) abortError ??= error;
        return;
      }
      if (isMaxTokensExceeded(error)) {
        sizeError ??= error;
        controller.abort();
        return;
      }
      failures.set(index, error);
    }
  };
  const worker = async (): Promise<void> => {
    while (next < runs.length && !stopped()) {
      const index = next++;
      await runBatch(index);
    }
  };
  const width = Math.max(1, Math.min(Math.floor(opts.concurrency), runs.length));
  try {
    await Promise.all(Array.from({ length: width }, worker));
  } finally {
    callerSignal?.removeEventListener('abort', forwardAbort);
  }
  const latencyMs = Date.now() - started;

  const requestIds: string[] = [];
  for (const outcome of outcomes) {
    if (outcome?.requestId !== undefined) requestIds.push(outcome.requestId);
  }
  requestIds.push(...failedIds);

  if (abortError !== undefined) throw abortError;
  if (sizeError !== undefined) {
    throw new StateTooLargeError(
      `Jev rejected the state as too large at fit stage ${skeleton.fitStage} ` +
        `(≈${skeleton.tokens} estimated tokens; the limit is ${JEV_STATE_LIMIT_TOKENS} for state + longest question)`,
      skeleton.fitStage,
      { cause: sizeError, requests: sent, requestIds },
    );
  }
  const succeeded = outcomes.filter((o): o is BatchOutcome => o !== undefined);
  // The Foreman rides in batch 0; the run fails as a whole only when no vote of it came back.
  const foremanAnswered = runs.some((run, index) => run.b === 0 && outcomes[index] !== undefined);
  if (!foremanAnswered || succeeded.length === 0) {
    const firstForeman = Math.max(
      0,
      runs.findIndex((run) => run.b === 0),
    );
    throw failures.get(firstForeman) ?? failures.values().next().value;
  }

  const results = succeeded.map((o) => o.result);
  // Fold each vote's batches on their own, then average across the votes.
  const perVote: CollectedAnswers[] = [];
  for (let vote = 0; vote < votes; vote++) {
    const own = runs.flatMap((run, index) => {
      const outcome = outcomes[index];
      return run.vote === vote && outcome !== undefined ? [outcome.result] : [];
    });
    if (own.length > 0) perVote.push(collectAnswers(own));
  }
  const collected = averageVotes(perVote);

  let inputTokens = 0;
  let outputTokens = 0;
  for (const outcome of succeeded) {
    inputTokens += outcome.result.usage.input_tokens;
    outputTokens += outcome.result.usage.output_tokens;
  }
  // A candidate no vote answered (its batch failed every time) stays unjudged, hence kept.
  let unjudged = skeleton.omitted.length;
  for (const batch of batches) {
    for (const id of batch.candidateIds) if (!collected.units.has(id)) unjudged += 1;
  }

  const telemetry: JevTelemetry = {
    model: results[0]?.model ?? client.defaultModel,
    requests: sent,
    inputTokens,
    outputTokens,
    latencyMs,
    requestIds,
    estimatedUsd: inputTokens * USD_PER_INPUT_TOKEN,
    stateTokens: skeleton.tokens,
    fitStage: skeleton.fitStage,
    unjudged,
  };

  return { ...collected, telemetry };
}
