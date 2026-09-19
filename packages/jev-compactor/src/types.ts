/**
 * jev-compactor — public and internal types. This file is the contract every module implements
 * against. Keep it dependency-free.
 */
import type { TypeSafeClient } from '@typesafe-ai/sdk';

// ───────────────────────────── messages ─────────────────────────────

/** Any chat message object. Adapters normalize these; the engine never mutates them. */
export type AnyMessage = Record<string, unknown>;

export type Role = 'system' | 'user' | 'assistant' | 'tool';
export type FrameKind = 'system' | 'user' | 'assistant' | 'tool_call' | 'tool_result';
export type MessageFormat = 'openai' | 'anthropic' | 'langchain' | 'plain';

/** One original message, normalized. `index` is its position in the caller's array. */
export interface Frame {
  index: number;
  role: Role;
  kind: FrameKind;
  /** Flattened text for Jev and heuristics. Never returned to the model. */
  text: string;
  chars: number;
  /** Estimated tokens of the ORIGINAL message (not of `text`). */
  tokens: number;
  /** File paths, URLs and dotted identifiers found in `text`. */
  paths: string[];
  /** Contains a fenced code block or a unified diff. */
  hasCode: boolean;
  /** Tool-call ids this frame issues (assistant) or answers (tool result). */
  toolCallIds: string[];
  /** Tool names issued or answered, for the skeleton. */
  toolNames: string[];
  /** Stable content hash (role + text) for dedup. */
  hash: string;
  /** Caller pin: `message.pin === true` or `options.pin(index, message)`. */
  pinned: boolean;
}

/**
 * The atomic keep/drop item: a single frame, or an assistant message that issues tool calls together
 * with every tool-result frame that answers them. Kept or dropped as a whole, so no message is ever
 * edited and no result is ever left without its call.
 */
export interface Unit {
  /** `u<n>`, n = position among units. */
  id: string;
  frames: Frame[];
  /** Original indices, ascending. */
  indices: number[];
  tokens: number;
  /** Concatenated frame text, used to build the skeleton excerpt. */
  text: string;
  /** True when any frame is a tool call or result. */
  isTool: boolean;
}

// ───────────────────────────── decisions & report ─────────────────────────────

export type Decision =
  | 'kept' // Jev said keep, or unjudged, or fail-open
  | 'pinned' // never a candidate
  | 'dropped' // Jev said drop at or above dropThreshold
  | 'duplicate' // exact duplicate of a later unit (code)
  | 'budget' // dropped oldest-first to meet maxTokens after Jev (code)
  | 'truncated' // allowTruncate: call kept, result truncated (v0: reserved, not emitted)
  | 'flagged'; // implicated in an action-level Foreman finding (kept, but marked)

export interface UnitReport {
  unit: string;
  indices: number[];
  decision: Decision;
  /** Jev P(keep) from the choice probabilities, when the unit was judged. */
  pKeep?: number;
  /** Jev confidence for the choice, when judged. */
  confidence?: number;
  /** Human-readable, e.g. `pinned:system`, `pinned:goal-path src/auth.ts`, `jev:drop p=0.93`. */
  reason: string;
  tokens: number;
}

export type ForemanKind = 'destructive' | 'exfiltration' | 'thrashing' | 'goal_drift';

export interface ForemanFinding {
  kind: ForemanKind;
  /** `pattern` = regex floor in code (probability 1); `jev` = noul over the whole state. */
  source: 'pattern' | 'jev';
  probability: number;
  /** `review` at/above reviewThreshold, `action` at/above actionThreshold. */
  level: 'review' | 'action';
  /** Frames implicated (pattern hits). Empty for whole-state Jev findings. */
  indices: number[];
  /** Matched snippet or pattern name. */
  evidence?: string;
}

export interface ForemanPattern {
  name: string;
  kind: 'destructive' | 'exfiltration';
  regex: RegExp;
}

export interface JevTelemetry {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Wall-clock for all batches (they run concurrently). */
  latencyMs: number;
  requestIds: string[];
  /** inputTokens × $0.042 / 1e6. */
  estimatedUsd: number;
  /** Estimated tokens of the skeleton state actually sent. */
  stateTokens: number;
  /** Abridging stage reached to fit the state (0 = none, 5 = candidates omitted). */
  fitStage: number;
  /** Units Jev never saw (stage 5). They are kept. */
  unjudged: number;
}

export type SkipReason = 'below_threshold' | 'cooldown' | 'nothing_to_judge' | 'jev_unavailable';

export interface CompactionReport {
  goal: string;
  format: MessageFormat;
  tokensBefore: number;
  tokensAfter: number;
  messagesBefore: number;
  messagesAfter: number;
  units: UnitReport[];
  foreman: ForemanFinding[];
  /** Jev progress score 0–2, when judged. */
  progress?: number;
  jev?: JevTelemetry;
  skipped?: SkipReason;
  /** Message of the error that caused fail-open, if any. */
  error?: string;
  /** Total ms including normalization and Jev. */
  latencyMs: number;
}

export interface CompactionResult<M = AnyMessage> {
  /** Kept messages are the SAME object references as the input. */
  messages: M[];
  report: CompactionReport;
  /** True when safetyGating is on and an action-level finding exists (and escrow did not approve). */
  blocked: boolean;
  /** Corrective system text for thrashing/goal drift. Appended as a system message for openai/
   *  langchain/plain formats; returned here only for anthropic (system lives outside the array). */
  systemAddendum?: string;
  /** False when the run was skipped (see report.skipped). */
  compacted: boolean;
}

// ───────────────────────────── options ─────────────────────────────

export type GoalOption = string | ((messages: AnyMessage[], frames: Frame[]) => string);
export type EscrowVerdict = 'approve' | 'block';

export interface CompactOptions {
  /** The agent's active goal. Default: the last user message's text (up to 500 chars). */
  goal?: GoalOption;
  /** Budget and trigger threshold in estimated tokens. Default 15_000. */
  maxTokens?: number;
  /** `always` compacts on every call; `auto` only when the estimate exceeds maxTokens.
   *  Default: `always` for compact(), `auto` for withCompaction(). */
  trigger?: 'auto' | 'always';
  /** Newest units never judged. Default 4. */
  keepRecent?: number;
  /** Units containing code/diffs within this many units of the end are pinned. Default 12. */
  pinCodeWithin?: number;
  /** Extra caller pins. */
  pin?: (index: number, message: AnyMessage) => boolean;
  /** Drop iff P(drop) ≥ this. Default 0.7 ("when in doubt, keep"). */
  dropThreshold?: number;
  /** Second-pass threshold when still over budget. Default 0.5. */
  dropThresholdSecondPass?: number;
  /** Units that always survive (after pins). Default 2. */
  minKeep?: number;
  /** Reserved for v0.2: keep call, truncate result. Default false. */
  allowTruncate?: boolean;
  /** Characters of a tool result shown in the skeleton before the omitted-note. Default 300. */
  truncateHeadChars?: number;
  /** Characters of a unit shown in the skeleton (head + tail) at stage 0. Default 1_500. */
  excerptChars?: number;
  /** Estimated-token budget for the skeleton state. Default 20_000 (Jev hard limit 32k). */
  stateTokens?: number;
  /** Estimated-token budget for state + all questions in one request. Default 56_000 (limit 64k). */
  requestTokens?: number;
  /** Concurrent Jev requests. Default 8. */
  concurrency?: number;
  /**
   * Ask every question this many times, in separate concurrent requests, and average the answers.
   * Jev's probabilities move a few hundredths between identical requests, which can flip a unit
   * near `dropThreshold`; 3 votes narrow that at 3× the (tiny) Jev cost and no extra latency.
   * Default 1.
   */
  votes?: number;
  /** Run the Foreman questions and honor `blocked`. Default false (findings are still reported). */
  safetyGating?: boolean;
  reviewThreshold?: number; // default 0.35
  actionThreshold?: number; // default 0.70
  /** Extra or replacement regex floor. A function receives the defaults and returns the full list. */
  patterns?:
    | readonly ForemanPattern[]
    | ((defaults: readonly ForemanPattern[]) => readonly ForemanPattern[]);
  /** Templates for the corrective system prompt; `false` disables injection. */
  correctivePrompts?: Partial<Record<'thrashing' | 'goal_drift', string>> | false;
  /** Throw instead of returning the input unchanged when Jev is unavailable. Default false. */
  failClosed?: boolean;
  /** Token counter for the ORIGINAL messages (e.g. tiktoken). Default: chars/2.5 heuristic. */
  countTokens?: (text: string) => number;
  /** Force the adapter. Default `auto`. */
  format?: MessageFormat | 'auto';
  /** Inject a configured TypeSafeClient. Otherwise one is built from apiKey/model/baseURL/env. */
  client?: TypeSafeClient;
  apiKey?: string;
  model?: string;
  baseURL?: string;
  /** Per-attempt Jev timeout. Default 10_000. */
  timeoutMs?: number;
  signal?: AbortSignal;
  onReport?: (report: CompactionReport) => void;
  /** Called with the highest action-level finding when safetyGating blocks. `approve` unblocks. */
  onEscrow?: (
    finding: ForemanFinding,
    result: CompactionResult,
  ) => EscrowVerdict | Promise<EscrowVerdict>;
}

export interface WithCompactionOptions extends CompactOptions {
  /** Minimum calls between two compactions of the same target. Default 1. */
  cooldownTurns?: number;
  /**
   * Log one line per wrapped call — pass-through, compacted, skipped, blocked — to stderr, or to
   * the given function. The cheapest way to see that the wrapper is live. Default false.
   */
  verbose?: boolean | ((line: string) => void);
}

export type WrapperShape = 'function' | 'openai' | 'anthropic' | 'langchain';

/** What a wrapper has done so far. Read it with `status(wrapped)`; `undefined` means not wrapped. */
export interface WrapperStatus {
  wrapped: true;
  shape: WrapperShape;
  trigger: 'auto' | 'always';
  maxTokens: number;
  safetyGating: boolean;
  cooldownTurns: number;
  /** Wrapped calls that carried a messages array. */
  calls: number;
  /** Calls where Jev ran and the history was compacted. */
  compactions: number;
  /** Calls that ran only the regex floor, by reason (`jev_unavailable` = failed open). */
  skipped: Record<SkipReason, number>;
  /** Calls that threw `CompactionBlockedError`. */
  blocked: number;
  /** The report of the most recent call. */
  lastReport?: CompactionReport;
}

export type SelfTestStage = 'key' | 'jev' | 'pipeline' | 'ok';

/** Result of `selfTest()`: an end-to-end run over a built-in history. */
export interface SelfTestResult {
  ok: boolean;
  /** The first stage that failed: no key, Jev unreachable, pipeline did not flag the built-in `rm -rf`; or `ok`. */
  stage: SelfTestStage;
  model?: string;
  latencyMs?: number;
  requestIds?: string[];
  messagesBefore: number;
  messagesAfter: number;
  /** Whether the built-in `rm -rf` proposal was flagged by the regex floor and by Jev. */
  destructiveFlagged: { pattern: boolean; jev: boolean };
  /** Redaction is the caller's job (the CLI and MCP server do it). */
  error?: string;
}

/** Fully-resolved options with every default applied. Internal. */
export type ResolvedOptions = Required<
  Omit<
    CompactOptions,
    | 'goal'
    | 'pin'
    | 'patterns'
    | 'correctivePrompts'
    | 'client'
    | 'apiKey'
    | 'model'
    | 'baseURL'
    | 'signal'
    | 'onReport'
    | 'onEscrow'
    | 'countTokens'
    | 'format'
  >
> & {
  goal: GoalOption | undefined;
  pin: ((index: number, message: AnyMessage) => boolean) | undefined;
  patterns: readonly ForemanPattern[];
  correctivePrompts: Record<'thrashing' | 'goal_drift', string> | false;
  client: TypeSafeClient | undefined;
  apiKey: string | undefined;
  model: string | undefined;
  baseURL: string | undefined;
  signal: AbortSignal | undefined;
  onReport: ((report: CompactionReport) => void) | undefined;
  onEscrow: CompactOptions['onEscrow'] | undefined;
  countTokens: (text: string) => number;
  format: MessageFormat | 'auto';
};

// ───────────────────────────── skeleton state (what Jev sees) ─────────────────────────────

export interface SkeletonEntry {
  /** Unit id, e.g. `u12`. */
  u: string;
  role: Role;
  /** Excerpted text for text units. */
  content?: string;
  /** For tool units: tool name(s), abridged input, abridged/omitted result. */
  tool?: string;
  input?: string;
  result?: string;
}

export interface SkeletonState {
  goal: string;
  note: string;
  messages: SkeletonEntry[];
}

export interface Skeleton {
  state: SkeletonState;
  /** Unit id → index in `state.messages`. Units omitted at stage 5 are absent. */
  position: Map<string, number>;
  /** Estimated tokens of `state`. */
  tokens: number;
  fitStage: number;
  /** Candidate unit ids that were omitted from the state (stage 5). */
  omitted: string[];
}

// ───────────────────────────── errors ─────────────────────────────

export class CompactionError extends Error {
  override name = 'CompactionError';
}
export class CompactionUnavailableError extends CompactionError {
  override name = 'CompactionUnavailableError';
}
export class UnsupportedTargetError extends CompactionError {
  override name = 'UnsupportedTargetError';
}
export class CompactionBlockedError extends CompactionError {
  override name = 'CompactionBlockedError';
  constructor(
    message: string,
    public readonly finding: ForemanFinding,
    public readonly result: CompactionResult,
  ) {
    super(message);
  }
}
