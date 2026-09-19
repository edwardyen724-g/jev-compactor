/**
 * `withCompaction(target)`: wraps a function, an OpenAI-shaped client, an Anthropic-shaped client
 * or a LangChain-shaped runnable so that every call compacts its messages first. The target is
 * never mutated — the wrapper is a Proxy that returns wrapped methods along the matched path and
 * forwards everything else — and the messages handed to the target are a new array holding the
 * caller's original message objects. `trigger` defaults to `auto`, so Jev is not asked until the
 * history exceeds `maxTokens`; after a run, the conversation's next `cooldownTurns` calls skip Jev.
 * The regex Foreman and safety gating apply on every call, skipped ones included.
 */
import { createHash } from 'node:crypto';
import { blockingFinding } from './decide.js';
import { type Compactor, DEFAULTS, makeCompactor, skipCompaction } from './engine.js';
import { actionIndices, groupUnits, normalize, pendingUnit } from './normalize.js';
import { summaryLine } from './render.js';
import {
  type AnyMessage,
  CompactionBlockedError,
  type CompactionReport,
  type CompactionResult,
  type CompactOptions,
  type ForemanFinding,
  type ResolvedOptions,
  type SkipReason,
  UnsupportedTargetError,
  type WithCompactionOptions,
  type WrapperShape,
  type WrapperStatus,
} from './types.js';

// biome-ignore lint/suspicious/noExplicitAny: a wrapped method must accept whatever the caller passes.
type AnyFn = (...args: any[]) => unknown;

type Shape = WrapperShape;

/** The property under which a wrapper exposes its `WrapperStatus`; read it with `status()`. */
export const STATUS: unique symbol = Symbol.for('jev-compactor.status');

const UNSUPPORTED_MESSAGE =
  'withCompaction: unsupported target. Expected one of: a function (messages, ...rest); ' +
  'an OpenAI-shaped client with chat.completions.create(params); ' +
  'an Anthropic-shaped client with messages.create(params); ' +
  'a LangChain-shaped runnable with invoke(input).';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFunction(value: unknown): value is AnyFn {
  return typeof value === 'function';
}

/** Reads `obj.a.b.c` without invoking anything but getters. */
function readPath(obj: unknown, path: readonly string[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (!isObject(current) && !isFunction(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

const OPENAI_PATH = ['chat', 'completions', 'create'] as const;
const ANTHROPIC_PATH = ['messages', 'create'] as const;
const LANGCHAIN_PATH = ['invoke'] as const;

/** Detection order is fixed: function, OpenAI, Anthropic, LangChain. */
function detectShape(target: unknown): Shape | undefined {
  if (isFunction(target)) return 'function';
  if (!isObject(target)) return undefined;
  if (isFunction(readPath(target, OPENAI_PATH))) return 'openai';
  if (isFunction(readPath(target, ANTHROPIC_PATH))) return 'anthropic';
  if (isFunction(readPath(target, LANGCHAIN_PATH))) return 'langchain';
  return undefined;
}

// ───────────────────────────── gate: trigger, cooldown, blocking ─────────────────────────────

/**
 * Cooldowns are tracked per conversation, so one wrapper (the usual module-level client) can serve
 * many at once without one conversation's run silencing another's. A conversation is identified by
 * its first user message — hashed from its JSON, so a history deserialized afresh on every request
 * still matches — falling back to the first message, or '' for an empty history.
 */
function conversationKey(messages: readonly AnyMessage[]): string {
  const first =
    messages.find((m) => isObject(m) && (m.role === 'user' || m.type === 'human')) ?? messages[0];
  if (first === undefined) return '';
  return createHash('sha1')
    .update(JSON.stringify(first) ?? '')
    .digest('hex');
}

/**
 * The finding a blocked result blocks on: the one about the pending action (the same one
 * `onEscrow` saw), else the first action-level finding.
 */
function blockedBy<M extends AnyMessage>(
  messages: readonly M[],
  result: CompactionResult<M>,
  opts: ResolvedOptions,
): ForemanFinding | undefined {
  const pending = pendingUnit(groupUnits(normalize([...messages], opts.format, opts.pin).frames));
  return (
    blockingFinding(result.report.foreman, pending === undefined ? [] : actionIndices(pending)) ??
    result.report.foreman.find((f) => f.level === 'action')
  );
}

/**
 * One per wrapper: runs the compactor, keeps the per-conversation cooldown counters, counts what
 * happened to every call (read through `status()`), and logs one line per call when `verbose`.
 */
class Gate {
  /** Conversation key → calls left to skip; an entry is removed once it reaches zero. */
  private readonly cooling = new Map<string, number>();
  private calls = 0;
  private compactions = 0;
  private blocked = 0;
  private readonly skipped: Record<SkipReason, number> = {
    below_threshold: 0,
    cooldown: 0,
    nothing_to_judge: 0,
    jev_unavailable: 0,
  };
  private lastReport: CompactionReport | undefined;

  constructor(
    private readonly compactor: Compactor,
    private readonly cooldownTurns: number,
    private readonly shape: Shape,
    private readonly log: ((line: string) => void) | undefined,
  ) {}

  status(): WrapperStatus {
    const opts = this.compactor.options;
    const status: WrapperStatus = {
      wrapped: true,
      shape: this.shape,
      trigger: opts.trigger,
      maxTokens: opts.maxTokens,
      safetyGating: opts.safetyGating,
      cooldownTurns: this.cooldownTurns,
      calls: this.calls,
      compactions: this.compactions,
      skipped: { ...this.skipped },
      blocked: this.blocked,
    };
    if (this.lastReport !== undefined) status.lastReport = this.lastReport;
    return status;
  }

  async run<M extends AnyMessage>(messages: readonly M[]): Promise<CompactionResult<M>> {
    this.calls++;
    const key = conversationKey(messages);
    const left = this.cooling.get(key) ?? 0;
    if (left > 0) {
      if (left === 1) this.cooling.delete(key);
      else this.cooling.set(key, left - 1);
      // Jev is skipped; the regex floor and safety gating are not.
      return this.gate(
        messages,
        this.record(await skipCompaction(messages, this.compactor.options, 'cooldown')),
      );
    }
    const result = this.record(await this.compactor.compact(messages));
    // A run that got past the trigger check arms the cooldown — a fail-open attempt included, so an
    // unreachable Jev is not retried (with its timeouts) on every turn. A blocked run does not: the
    // model was not called, and a retry of the same history must be gated again.
    if (this.cooldownTurns > 0 && result.report.skipped !== 'below_threshold' && !result.blocked) {
      this.cooling.set(key, this.cooldownTurns);
    }
    return this.gate(messages, result);
  }

  /** Counts the outcome, remembers the report, logs the summary line. */
  private record<M extends AnyMessage>(result: CompactionResult<M>): CompactionResult<M> {
    const { report } = result;
    this.lastReport = report;
    if (report.skipped !== undefined) this.skipped[report.skipped]++;
    else if (result.compacted) this.compactions++;
    this.log?.(`jev-compactor: ${summaryLine(result)}`);
    return result;
  }

  private gate<M extends AnyMessage>(
    messages: readonly M[],
    result: CompactionResult<M>,
  ): CompactionResult<M> {
    if (!result.blocked) return result;
    const finding = blockedBy(messages, result, this.compactor.options);
    if (finding === undefined) return result;
    this.blocked++;
    const evidence = finding.evidence === undefined ? '' : `: ${finding.evidence}`;
    throw new CompactionBlockedError(
      `Compaction blocked by ${finding.kind} finding (${finding.source}${evidence})`,
      finding,
      result,
    );
  }
}

// ───────────────────────────── wrapped methods ─────────────────────────────

/**
 * The corrective addendum appended to an Anthropic `system`: joined with a blank line onto a
 * string, pushed as a text block onto an array (a new array), or used as the system when there
 * was none. An unrecognized shape is left untouched.
 */
export function appendSystem(system: unknown, addendum: string): unknown {
  if (typeof system === 'string') return system === '' ? addendum : `${system}\n\n${addendum}`;
  if (Array.isArray(system)) return [...system, { type: 'text', text: addendum }];
  if (system === undefined || system === null) return addendum;
  return system;
}

/** The request-promise helpers of both SDKs' `APIPromise`, kept reachable through the wrapper. */
const FORWARDED_METHODS = ['withResponse', 'asResponse'] as const;

/**
 * Runs `call` once `before` settles and returns a promise of its result that also carries
 * `withResponse()`/`asResponse()`, forwarded to whatever `call` returned (the SDK's `APIPromise`),
 * so `client.chat.completions.create(params).withResponse()` keeps working through the wrapper.
 */
function deferCall<T>(before: Promise<T>, call: (value: T) => unknown): Promise<unknown> {
  // Boxed, so a promise returned by `call` is captured itself rather than flattened into its value.
  const started = before.then((value) => ({ returned: call(value) }));
  const result: Promise<unknown> = started.then(({ returned }) => returned);
  for (const name of FORWARDED_METHODS) {
    Object.defineProperty(result, name, {
      configurable: true,
      writable: true,
      enumerable: false,
      value: (...args: unknown[]): Promise<unknown> =>
        started.then(({ returned }) => {
          const method: unknown = isObject(returned) ? returned[name] : undefined;
          if (!isFunction(method)) {
            throw new TypeError(`${name} is not a function on the wrapped call's result`);
          }
          return method.apply(returned, args);
        }),
    });
  }
  // A caller that only awaits a forwarded helper observes a failure there; `result` itself must
  // not surface it a second time as an unhandled rejection.
  result.catch(() => undefined);
  return result;
}

/** `(messages, ...rest)` → compact `messages` when it is an array, then call through. */
function wrapFunction(fn: AnyFn, gate: Gate): AnyFn {
  return async function compacting(this: unknown, ...args: unknown[]): Promise<unknown> {
    const [messages, ...rest] = args;
    if (!Array.isArray(messages)) return fn.apply(this, args);
    const result = await gate.run(messages as AnyMessage[]);
    return fn.apply(this, [result.messages, ...rest]);
  };
}

/** `create(params, ...rest)` for OpenAI (`params.messages`) and Anthropic (`+ params.system`). */
function wrapCreate(
  create: AnyFn,
  owner: object,
  gate: Gate,
  shape: 'openai' | 'anthropic',
): AnyFn {
  return function compactingCreate(...args: unknown[]): unknown {
    const [params, ...rest] = args;
    if (!isObject(params) || !Array.isArray(params.messages)) return create.apply(owner, args);
    const compacted = gate.run(params.messages as AnyMessage[]).then((result) => {
      const next: Record<string, unknown> = { ...params, messages: result.messages };
      if (shape === 'anthropic' && result.systemAddendum !== undefined) {
        next.system = appendSystem(params.system, result.systemAddendum);
      }
      return next;
    });
    return deferCall(compacted, (next) => create.apply(owner, [next, ...rest]));
  };
}

/** `invoke(input, ...rest)`: a message array, or an object carrying a `messages` array. */
function wrapInvoke(invoke: AnyFn, owner: object, gate: Gate): AnyFn {
  return function compactingInvoke(...args: unknown[]): unknown {
    const [input, ...rest] = args;
    if (Array.isArray(input)) {
      const compacted = gate.run(input as AnyMessage[]).then((result) => result.messages);
      return deferCall(compacted, (messages) => invoke.apply(owner, [messages, ...rest]));
    }
    if (isObject(input) && Array.isArray(input.messages)) {
      const compacted = gate
        .run(input.messages as AnyMessage[])
        .then((result) => ({ ...input, messages: result.messages }));
      return deferCall(compacted, (next) => invoke.apply(owner, [next, ...rest]));
    }
    return invoke.apply(owner, args);
  };
}

// ───────────────────────────── proxies ─────────────────────────────

/**
 * A proxy's `get` trap may not substitute a value for an own property that is both
 * non-configurable and non-writable; such properties are handed through untouched.
 */
function isLocked(target: object, prop: PropertyKey): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(target, prop);
  return (
    descriptor !== undefined && descriptor.configurable === false && descriptor.writable === false
  );
}

/**
 * Refuses a target whose method path cannot be intercepted (a frozen client or resource): handing
 * the real method through would silently disable compaction and safety gating.
 */
function assertInterceptable(target: object, path: readonly string[]): void {
  let current: unknown = target;
  for (const [i, key] of path.entries()) {
    if (!isObject(current) && !isFunction(current)) return;
    if (isLocked(current as object, key)) {
      const locked = path.slice(0, i + 1).join('.');
      throw new UnsupportedTargetError(
        `withCompaction: cannot intercept ${path.join('.')}: '${locked}' is a non-configurable, ` +
          'non-writable property (a frozen object), which a Proxy may not substitute. Wrap the ' +
          'client before freezing it, or wrap a function instead.',
      );
    }
    current = (current as Record<string, unknown>)[key];
  }
}

/**
 * A Proxy over `obj` that returns wrapped methods along `path` and forwards every other
 * property. Nested objects on the path get their own proxy; forwarded functions are bound to the
 * real object so methods keep working on class instances (private fields included). Results are
 * cached per property so repeated reads return the same value.
 */
function proxyAlong(
  obj: object,
  path: readonly string[],
  leaf: (method: AnyFn, owner: object) => AnyFn,
  statusOf?: () => WrapperStatus,
): object {
  const [head, ...tail] = path;
  const cache = new Map<PropertyKey, { source: unknown; value: unknown }>();
  return new Proxy(obj, {
    get(target, prop) {
      // Only the outermost proxy answers for the wrapper.
      if (statusOf !== undefined && prop === STATUS) return statusOf();
      const source: unknown = Reflect.get(target, prop, target);
      if (isLocked(target, prop)) return source;
      const hit = cache.get(prop);
      if (hit !== undefined && hit.source === source) return hit.value;
      let value: unknown = source;
      if (prop === head) {
        if (tail.length === 0) {
          if (isFunction(source)) value = leaf(source, target);
        } else if (isObject(source) || isFunction(source)) {
          value = proxyAlong(source as object, tail, leaf);
        }
      } else if (isFunction(source)) {
        value = source.bind(target);
      }
      cache.set(prop, { source, value });
      return value;
    },
  });
}

// ───────────────────────────── withCompaction ─────────────────────────────

/** The adapter a client shape implies, unless the caller forced one. */
function withShapeFormat(options: CompactOptions, shape: Shape): CompactOptions {
  if (options.format !== undefined) return options;
  if (shape === 'openai') return { ...options, format: 'openai' };
  if (shape === 'anthropic') return { ...options, format: 'anthropic' };
  return options;
}

/**
 * Wraps `target` so that its calls compact their messages first. Detects, in order: a function
 * `(messages, ...rest)`; an OpenAI-shaped client (`chat.completions.create`); an Anthropic-shaped
 * client (`messages.create`, with the corrective addendum appended to `params.system`); a
 * LangChain-shaped runnable (`invoke` with a message array or `{messages}`). Anything else — or a
 * client whose method path is frozen and cannot be intercepted — throws `UnsupportedTargetError`.
 * When safety gating blocks a call, `CompactionBlockedError` is thrown instead of calling the
 * target (unless `onEscrow` approved); a blocked call never arms the cooldown.
 */
export function withCompaction<T>(target: T, options?: WithCompactionOptions): T {
  const shape = detectShape(target);
  if (shape === undefined) throw new UnsupportedTargetError(UNSUPPORTED_MESSAGE);

  const all: WithCompactionOptions = options ?? {};
  const { cooldownTurns, verbose, ...compactOptions } = all;
  const turns = Math.max(0, Math.floor(cooldownTurns ?? DEFAULTS.cooldownTurns));
  const log =
    verbose === true
      ? (line: string): void => {
          process.stderr.write(`${line}\n`);
        }
      : typeof verbose === 'function'
        ? verbose
        : undefined;
  const compactor = makeCompactor(withShapeFormat(compactOptions, shape), 'wrap');
  const gate = new Gate(compactor, turns, shape, log);
  const statusOf = (): WrapperStatus => gate.status();

  switch (shape) {
    case 'function': {
      const wrapped = wrapFunction(target as unknown as AnyFn, gate);
      Object.defineProperty(wrapped, STATUS, {
        get: statusOf,
        enumerable: false,
        configurable: true,
      });
      return wrapped as unknown as T;
    }
    case 'openai':
      assertInterceptable(target as unknown as object, OPENAI_PATH);
      return proxyAlong(
        target as unknown as object,
        OPENAI_PATH,
        (create, owner) => wrapCreate(create, owner, gate, 'openai'),
        statusOf,
      ) as T;
    case 'anthropic':
      assertInterceptable(target as unknown as object, ANTHROPIC_PATH);
      return proxyAlong(
        target as unknown as object,
        ANTHROPIC_PATH,
        (create, owner) => wrapCreate(create, owner, gate, 'anthropic'),
        statusOf,
      ) as T;
    case 'langchain':
      assertInterceptable(target as unknown as object, LANGCHAIN_PATH);
      return proxyAlong(
        target as unknown as object,
        LANGCHAIN_PATH,
        (invoke, owner) => wrapInvoke(invoke, owner, gate),
        statusOf,
      ) as T;
  }
}

// ───────────────────────────── is it wired in? ─────────────────────────────

/**
 * The `WrapperStatus` of something returned by `withCompaction`, or `undefined` for anything else
 * (the unwrapped client, a plain function, `null`). Counters are live: read again after a call.
 */
export function status(target: unknown): WrapperStatus | undefined {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) {
    return undefined;
  }
  const value: unknown = (target as Record<PropertyKey, unknown>)[STATUS];
  return isObject(value) && value.wrapped === true
    ? (value as unknown as WrapperStatus)
    : undefined;
}

/** True when `target` came out of `withCompaction`. */
export function isWrapped(target: unknown): boolean {
  return status(target) !== undefined;
}
