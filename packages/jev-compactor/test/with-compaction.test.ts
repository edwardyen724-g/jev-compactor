/**
 * with-compaction.ts — shape tests, no network. `trigger: 'auto'` with a huge `maxTokens` keeps
 * every call below the threshold, so Jev is never reached; a throwing client is injected anyway
 * to prove it. The cooldown and blocking tests use `trigger: 'always'` on a chat where every unit
 * is pinned (nothing to judge, still no Jev) or where the regex Foreman fires.
 */
import { APIConnectionError, type TypeSafeClient } from '@typesafe-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  type AnyMessage,
  CompactionBlockedError,
  type CompactionReport,
  UnsupportedTargetError,
  type WithCompactionOptions,
} from '../src/types.js';
import { appendSystem, withCompaction } from '../src/with-compaction.js';

// ───────────────────────────── helpers ─────────────────────────────

function throwingClient(): { client: TypeSafeClient; calls: () => number } {
  let n = 0;
  const client = {
    defaultModel: 'jev-latest',
    systemOne(): never {
      n += 1;
      throw new APIConnectionError('connect ECONNREFUSED 127.0.0.1:443');
    },
  } as unknown as TypeSafeClient;
  return { client, calls: () => n };
}

/** Below-threshold options: no Jev call can happen. */
function quiet(extra: WithCompactionOptions = {}): {
  options: WithCompactionOptions;
  calls: () => number;
} {
  const { client, calls } = throwingClient();
  return { options: { trigger: 'auto', maxTokens: 1e9, client, ...extra }, calls };
}

const MESSAGES: AnyMessage[] = [
  { role: 'system', content: 'Be brief.' },
  { role: 'user', content: 'What is 2 + 2?' },
  { role: 'assistant', content: '4.' },
  { role: 'user', content: 'And 3 + 3?' },
];

function expectSameObjects(actual: unknown, expected: readonly AnyMessage[]): void {
  expect(Array.isArray(actual)).toBe(true);
  const list = actual as unknown[];
  expect(list).toHaveLength(expected.length);
  for (const [i, message] of list.entries()) expect(message).toBe(expected[i]);
}

// ───────────────────────────── function target ─────────────────────────────

describe('withCompaction — function', () => {
  it('compacts the first argument and passes the rest through', async () => {
    const { options, calls } = quiet();
    const fn = vi.fn(async (messages: AnyMessage[], extra: unknown) => ({ messages, extra }));
    const wrapped = withCompaction(fn, options);
    expect(wrapped).not.toBe(fn);

    const out = await wrapped(MESSAGES, { temperature: 0 });
    expect(calls()).toBe(0);
    expect(fn).toHaveBeenCalledTimes(1);
    const [received, extra] = fn.mock.calls[0] as [AnyMessage[], unknown];
    expect(received).not.toBe(MESSAGES); // a new array …
    expectSameObjects(received, MESSAGES); // … holding the same objects
    expect(extra).toEqual({ temperature: 0 });
    expect(out.messages).toBe(received);
  });

  it('passes a non-array first argument through untouched', async () => {
    const { options } = quiet();
    const fn = vi.fn(async (input: unknown) => input);
    const wrapped = withCompaction(fn, options);
    expect(await wrapped('hello')).toBe('hello');
    expect(fn).toHaveBeenCalledWith('hello');
  });
});

// ───────────────────────────── OpenAI shape ─────────────────────────────

describe('withCompaction — OpenAI shape', () => {
  function openaiClient() {
    const create = vi.fn(function (this: unknown, params: Record<string, unknown>) {
      return Promise.resolve({ params, self: this });
    });
    const target = {
      baseURL: 'https://api.example.test/v1',
      chat: { completions: { create }, other: 'chat-level' },
      embeddings: { create: vi.fn(async () => 'embedding') },
      describe(): string {
        return this.baseURL;
      },
    };
    return { target, create };
  }

  it('wraps chat.completions.create, replacing params.messages with a new array of the same objects', async () => {
    const { options, calls } = quiet();
    const { target, create } = openaiClient();
    const wrapped = withCompaction(target, options);
    const params = { model: 'gpt-x', messages: MESSAGES, temperature: 0.2 };

    const out = (await wrapped.chat.completions.create(params)) as {
      params: Record<string, unknown>;
      self: unknown;
    };
    expect(calls()).toBe(0);
    expect(create).toHaveBeenCalledTimes(1);
    expect(out.params).not.toBe(params);
    expect(out.params.model).toBe('gpt-x');
    expect(out.params.temperature).toBe(0.2);
    expect(out.params.messages).not.toBe(MESSAGES);
    expectSameObjects(out.params.messages, MESSAGES);
    expect(out.self).toBe(target.chat.completions); // `this` is the real resource

    // The caller's params object was not touched.
    expect(params.messages).toBe(MESSAGES);
  });

  it('does not mutate the target and forwards everything else', async () => {
    const { options } = quiet();
    const { target, create } = openaiClient();
    const before = JSON.stringify(target);
    const wrapped = withCompaction(target, options);

    expect(wrapped).not.toBe(target);
    expect(wrapped.chat).not.toBe(target.chat);
    expect(wrapped.chat.completions.create).not.toBe(create);
    expect(wrapped.chat.completions.create).toBe(wrapped.chat.completions.create); // stable
    expect(target.chat.completions.create).toBe(create); // original untouched
    expect(JSON.stringify(target)).toBe(before);

    expect(wrapped.baseURL).toBe(target.baseURL);
    expect(wrapped.chat.other).toBe('chat-level');
    expect(wrapped.embeddings).toBe(target.embeddings);
    expect(await wrapped.embeddings.create()).toBe('embedding');
    expect(wrapped.describe()).toBe(target.baseURL); // `this` bound to the real target
    expect('chat' in wrapped).toBe(true);
    expect(Object.keys(wrapped)).toEqual(Object.keys(target));
  });

  it('calls through when params carry no messages array', async () => {
    const { options } = quiet();
    const { target, create } = openaiClient();
    const wrapped = withCompaction(target, options);
    await wrapped.chat.completions.create({ model: 'gpt-x' });
    expect(create).toHaveBeenCalledWith({ model: 'gpt-x' });
  });

  it('reports with the openai adapter even for plain messages', async () => {
    const reports: CompactionReport[] = [];
    const { options } = quiet({ trigger: 'always', onReport: (r) => reports.push(r) });
    const { target } = openaiClient();
    const wrapped = withCompaction(target, options);
    await wrapped.chat.completions.create({ model: 'gpt-x', messages: MESSAGES });
    expect(reports[0]?.format).toBe('openai');
  });
});

// ───────────────────────────── Anthropic shape ─────────────────────────────

describe('withCompaction — Anthropic shape', () => {
  function anthropicClient() {
    const create = vi.fn(function (this: unknown, params: Record<string, unknown>) {
      return Promise.resolve({ params, self: this });
    });
    const target = {
      messages: { create, batches: { list: vi.fn(async () => []) } },
      apiVersion: '2023-06-01',
    };
    return { target, create };
  }

  it('wraps messages.create with a string system left as is', async () => {
    const { options, calls } = quiet();
    const { target, create } = anthropicClient();
    const wrapped = withCompaction(target, options);
    const params = { model: 'claude-x', system: 'Be terse.', max_tokens: 64, messages: MESSAGES };

    const out = (await wrapped.messages.create(params)) as {
      params: Record<string, unknown>;
      self: unknown;
    };
    expect(calls()).toBe(0);
    expect(create).toHaveBeenCalledTimes(1);
    expect(out.params.system).toBe('Be terse.');
    expect(out.params.max_tokens).toBe(64);
    expect(out.params.messages).not.toBe(MESSAGES);
    expectSameObjects(out.params.messages, MESSAGES);
    expect(out.self).toBe(target.messages);
    expect(params.messages).toBe(MESSAGES);
  });

  it('wraps messages.create with an array system left as the same array', async () => {
    const { options } = quiet();
    const { target } = anthropicClient();
    const wrapped = withCompaction(target, options);
    const system = [{ type: 'text', text: 'Be terse.' }];
    const out = (await wrapped.messages.create({
      model: 'claude-x',
      system,
      messages: MESSAGES,
    })) as {
      params: Record<string, unknown>;
    };
    expect(out.params.system).toBe(system);
    expect(system).toHaveLength(1);
  });

  it('forwards the rest of the messages resource and the client', async () => {
    const { options } = quiet();
    const { target } = anthropicClient();
    const wrapped = withCompaction(target, options);
    expect(wrapped.apiVersion).toBe('2023-06-01');
    expect(wrapped.messages).not.toBe(target.messages);
    expect(wrapped.messages.batches).toBe(target.messages.batches);
    expect(await wrapped.messages.batches.list()).toEqual([]);
  });

  it('uses the anthropic adapter, so a corrective note never lands in the array', async () => {
    const reports: CompactionReport[] = [];
    const { options } = quiet({ trigger: 'always', onReport: (r) => reports.push(r) });
    const { target } = anthropicClient();
    const wrapped = withCompaction(target, options);
    await wrapped.messages.create({ model: 'claude-x', messages: MESSAGES });
    expect(reports[0]?.format).toBe('anthropic');
  });

  it('appendSystem joins a string, extends an array, and creates a missing system', () => {
    expect(appendSystem('Be terse.', 'Note.')).toBe('Be terse.\n\nNote.');
    expect(appendSystem('', 'Note.')).toBe('Note.');
    const array = [{ type: 'text', text: 'Be terse.' }];
    const extended = appendSystem(array, 'Note.') as unknown[];
    expect(extended).not.toBe(array);
    expect(extended).toEqual([
      { type: 'text', text: 'Be terse.' },
      { type: 'text', text: 'Note.' },
    ]);
    expect(array).toHaveLength(1);
    expect(appendSystem(undefined, 'Note.')).toBe('Note.');
    expect(appendSystem(null, 'Note.')).toBe('Note.');
    const odd = { unexpected: true };
    expect(appendSystem(odd, 'Note.')).toBe(odd);
  });
});

// ───────────────────────────── LangChain shape ─────────────────────────────

describe('withCompaction — LangChain shape', () => {
  function runnable() {
    const invoke = vi.fn(function (this: unknown, input: unknown, config?: unknown) {
      return Promise.resolve({ input, config, self: this });
    });
    const target = { invoke, name: 'agent', stream: vi.fn() };
    return { target, invoke };
  }

  it('compacts a message-array input', async () => {
    const { options, calls } = quiet();
    const { target, invoke } = runnable();
    const wrapped = withCompaction(target, options);
    const out = (await wrapped.invoke(MESSAGES, { tags: ['t'] })) as {
      input: unknown;
      config: unknown;
      self: unknown;
    };
    expect(calls()).toBe(0);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(out.input).not.toBe(MESSAGES);
    expectSameObjects(out.input, MESSAGES);
    expect(out.config).toEqual({ tags: ['t'] });
    expect(out.self).toBe(target);
  });

  it('compacts a {messages} input and keeps its other keys', async () => {
    const { options } = quiet();
    const { target } = runnable();
    const wrapped = withCompaction(target, options);
    const input = { messages: MESSAGES, thread: 'abc' };
    const out = (await wrapped.invoke(input)) as { input: Record<string, unknown> };
    expect(out.input).not.toBe(input);
    expect(out.input.thread).toBe('abc');
    expectSameObjects(out.input.messages, MESSAGES);
    expect(input.messages).toBe(MESSAGES);
  });

  it('passes any other input through and forwards other members', async () => {
    const { options } = quiet();
    const { target, invoke } = runnable();
    const wrapped = withCompaction(target, options);
    await wrapped.invoke('plain string');
    expect(invoke).toHaveBeenCalledWith('plain string');
    await wrapped.invoke({ question: 'x' });
    expect(invoke).toHaveBeenLastCalledWith({ question: 'x' });
    expect(wrapped.name).toBe('agent');
    expect(wrapped.stream).not.toBe(undefined);
    expect(target.invoke).toBe(invoke);
  });
});

// ───────────────────────────── unsupported ─────────────────────────────

describe('withCompaction — unsupported targets', () => {
  it('throws UnsupportedTargetError naming the four shapes', () => {
    for (const target of [
      {},
      { chat: {} },
      { messages: {} },
      42,
      null,
      undefined,
      'x',
      { invoke: 'not a function' },
    ]) {
      let caught: unknown;
      try {
        withCompaction(target);
      } catch (e: unknown) {
        caught = e;
      }
      expect(caught, String(target)).toBeInstanceOf(UnsupportedTargetError);
      if (caught instanceof UnsupportedTargetError) {
        expect(caught.message).toContain('chat.completions.create');
        expect(caught.message).toContain('messages.create');
        expect(caught.message).toContain('invoke');
        expect(caught.message).toContain('function');
      }
    }
  });
});

// ───────────────────────────── cooldown & blocking ─────────────────────────────

describe('withCompaction — cooldown', () => {
  /** Every unit pinned (system + last keepRecent): a run reaches nothing_to_judge without Jev. */
  const SHORT: AnyMessage[] = [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Ping?' },
  ];

  it('skips the next cooldownTurns calls after a run, then runs again', async () => {
    const reports: CompactionReport[] = [];
    const { options, calls } = quiet({ trigger: 'always', onReport: (r) => reports.push(r) });
    const fn = vi.fn(async (messages: AnyMessage[]) => messages);
    const wrapped = withCompaction(fn, options); // cooldownTurns defaults to 1

    for (let i = 0; i < 4; i++) expectSameObjects(await wrapped(SHORT), SHORT);
    expect(calls()).toBe(0);
    expect(fn).toHaveBeenCalledTimes(4);
    expect(reports.map((r) => r.skipped)).toEqual([
      'nothing_to_judge',
      'cooldown',
      'nothing_to_judge',
      'cooldown',
    ]);
    const skipped = reports[1] as CompactionReport;
    expect(skipped.tokensBefore).toBe(skipped.tokensAfter);
    expect(skipped.messagesBefore).toBe(SHORT.length);
    expect(skipped.units).toEqual([]);
  });

  it('honors cooldownTurns: 2 and cooldownTurns: 0', async () => {
    const two: CompactionReport[] = [];
    const wrappedTwo = withCompaction(async (m: AnyMessage[]) => m, {
      ...quiet({ trigger: 'always', onReport: (r) => two.push(r) }).options,
      cooldownTurns: 2,
    });
    for (let i = 0; i < 4; i++) await wrappedTwo(SHORT);
    expect(two.map((r) => r.skipped)).toEqual([
      'nothing_to_judge',
      'cooldown',
      'cooldown',
      'nothing_to_judge',
    ]);

    const zero: CompactionReport[] = [];
    const wrappedZero = withCompaction(async (m: AnyMessage[]) => m, {
      ...quiet({ trigger: 'always', onReport: (r) => zero.push(r) }).options,
      cooldownTurns: 0,
    });
    for (let i = 0; i < 3; i++) await wrappedZero(SHORT);
    expect(zero.map((r) => r.skipped)).toEqual([
      'nothing_to_judge',
      'nothing_to_judge',
      'nothing_to_judge',
    ]);
  });

  it('does not arm the cooldown on a below-threshold skip', async () => {
    const reports: CompactionReport[] = [];
    const { options } = quiet({ onReport: (r) => reports.push(r) });
    const wrapped = withCompaction(async (m: AnyMessage[]) => m, options);
    for (let i = 0; i < 3; i++) await wrapped(SHORT);
    expect(reports.map((r) => r.skipped)).toEqual([
      'below_threshold',
      'below_threshold',
      'below_threshold',
    ]);
  });
});

describe('withCompaction — blocking', () => {
  const DANGEROUS: AnyMessage[] = [
    { role: 'user', content: 'Free up space.' },
    { role: 'assistant', content: 'Running `rm -rf /var/lib/data` now.' },
  ];

  it('throws CompactionBlockedError instead of calling the target when safety gating blocks', async () => {
    const { options } = quiet({ trigger: 'always', safetyGating: true });
    const fn = vi.fn(async (messages: AnyMessage[]) => messages);
    const wrapped = withCompaction(fn, options);

    let caught: unknown;
    try {
      await wrapped(DANGEROUS);
    } catch (e: unknown) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CompactionBlockedError);
    if (caught instanceof CompactionBlockedError) {
      expect(caught.finding).toMatchObject({ kind: 'destructive', level: 'action', indices: [1] });
      expect(caught.result.blocked).toBe(true);
      expect(caught.message).toContain('destructive');
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it('calls the target when onEscrow approves', async () => {
    const { options } = quiet({ trigger: 'always', safetyGating: true, onEscrow: () => 'approve' });
    const fn = vi.fn(async (messages: AnyMessage[]) => messages);
    const wrapped = withCompaction(fn, options);
    expectSameObjects(await wrapped(DANGEROUS), DANGEROUS);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────── gating on every call ─────────────────────────────

describe('withCompaction — gating on every call', () => {
  const RM_RF: AnyMessage[] = [
    { role: 'user', content: 'Free up space.' },
    { role: 'assistant', content: 'Running `rm -rf /var/lib/data` now.' },
  ];
  /** Same conversation as RM_RF (same first user message), benign so far. */
  const SAME_CONVERSATION: AnyMessage[] = [
    RM_RF[0] as AnyMessage,
    { role: 'assistant', content: 'Let me look at what is using the disk first.' },
  ];
  const OTHER: AnyMessage[] = [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Ping?' },
  ];

  it('gates a history below the auto threshold: the regex floor runs without Jev', async () => {
    const { options, calls } = quiet({ safetyGating: true }); // trigger auto, huge maxTokens
    const fn = vi.fn(async (m: AnyMessage[]) => m);
    const wrapped = withCompaction(fn, options);
    await expect(wrapped(RM_RF)).rejects.toBeInstanceOf(CompactionBlockedError);
    expect(fn).not.toHaveBeenCalled();
    expect(calls()).toBe(0);
    expectSameObjects(await wrapped(OTHER), OTHER);
  });

  it('never arms the cooldown on a blocked call: a retry of the same history is gated again', async () => {
    const { options } = quiet({ trigger: 'always', safetyGating: true });
    const fn = vi.fn(async (m: AnyMessage[]) => m);
    const wrapped = withCompaction(fn, options);
    for (let i = 0; i < 4; i++) {
      await expect(wrapped(RM_RF)).rejects.toBeInstanceOf(CompactionBlockedError);
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it('gates a cooldown skip too, reporting the findings it found', async () => {
    const reports: CompactionReport[] = [];
    const { options } = quiet({
      trigger: 'always',
      safetyGating: true,
      onReport: (r) => reports.push(r),
    });
    const fn = vi.fn(async (m: AnyMessage[]) => m);
    const wrapped = withCompaction(fn, options);
    await wrapped(SAME_CONVERSATION); // runs (nothing to judge) and arms the cooldown
    let caught: unknown;
    try {
      await wrapped(RM_RF);
    } catch (e: unknown) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CompactionBlockedError);
    if (caught instanceof CompactionBlockedError) {
      expect(caught.result.report.skipped).toBe('cooldown');
      expect(caught.finding).toMatchObject({ kind: 'destructive', indices: [1] });
    }
    expect(fn).toHaveBeenCalledTimes(1);
    // With safetyGating on, the first call asks Jev for the Foreman (unreachable here, so it fails
    // open) — and a fail-open attempt arms the cooldown, so the second call is a cooldown skip.
    expect(reports.map((r) => r.skipped)).toEqual(['jev_unavailable', 'cooldown']);
    expect(reports[1]?.foreman).toHaveLength(1);
  });

  it('tracks the cooldown per conversation, so one wrapper serves several', async () => {
    const reports: CompactionReport[] = [];
    const { options } = quiet({ trigger: 'always', onReport: (r) => reports.push(r) });
    const wrapped = withCompaction(async (m: AnyMessage[]) => m, options);
    const A: AnyMessage[] = [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'A?' },
    ];
    const B: AnyMessage[] = [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'B?' },
    ];
    for (const conversation of [A, B, A, B, A]) await wrapped(conversation);
    expect(reports.map((r) => r.skipped)).toEqual([
      'nothing_to_judge',
      'nothing_to_judge',
      'cooldown',
      'cooldown',
      'nothing_to_judge',
    ]);
  });

  it("another conversation's run never silences the gate for this one", async () => {
    const { options } = quiet({ trigger: 'always', safetyGating: true });
    const fn = vi.fn(async (m: AnyMessage[]) => m);
    const wrapped = withCompaction(fn, options);
    expectSameObjects(await wrapped(OTHER), OTHER);
    await expect(wrapped(RM_RF)).rejects.toBeInstanceOf(CompactionBlockedError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────── request-promise helpers ─────────────────────────────

describe('withCompaction — request promise helpers', () => {
  /** The shape of both SDKs' APIPromise: a Promise with withResponse()/asResponse(). */
  class ApiPromise<T> extends Promise<T> {
    withResponse(): Promise<{ data: T; requestId: string }> {
      return this.then((data) => ({ data, requestId: 'req_1' }));
    }
    asResponse(): Promise<string> {
      return Promise.resolve('raw');
    }
  }
  type Created = { params: Record<string, unknown> };

  it('forwards withResponse()/asResponse() of the wrapped create, and the bare promise for no messages', async () => {
    const { options } = quiet();
    const create = vi.fn(
      (params: Record<string, unknown>) =>
        new ApiPromise<Created>((resolve) => resolve({ params })),
    );
    const wrapped = withCompaction({ chat: { completions: { create } } }, options);
    const p = wrapped.chat.completions.create({ model: 'gpt-x', messages: MESSAGES });
    const { data, requestId } = await p.withResponse();
    expect(requestId).toBe('req_1');
    expectSameObjects(data.params.messages, MESSAGES);
    expect(await p.asResponse()).toBe('raw');
    expect((await p).params.model).toBe('gpt-x');
    expect(create).toHaveBeenCalledTimes(1);

    const raw = wrapped.chat.completions.create({ model: 'gpt-x' });
    expect(raw).toBeInstanceOf(ApiPromise);
  });

  it('rejects through the helpers when the call is blocked, with no unhandled rejection', async () => {
    const { options } = quiet({ trigger: 'always', safetyGating: true });
    const create = vi.fn(
      (params: Record<string, unknown>) =>
        new ApiPromise<Created>((resolve) => resolve({ params })),
    );
    const wrapped = withCompaction({ messages: { create } }, options);
    const p = wrapped.messages.create({
      model: 'claude-x',
      messages: [
        { role: 'user', content: 'Free up space.' },
        { role: 'assistant', content: 'Running `rm -rf /var/lib/data` now.' },
      ],
    });
    await expect(p.withResponse()).rejects.toBeInstanceOf(CompactionBlockedError);
    await expect(p).rejects.toBeInstanceOf(CompactionBlockedError);
    expect(create).not.toHaveBeenCalled();
  });
});

// ───────────────────────────── frozen targets ─────────────────────────────

describe('withCompaction — frozen targets', () => {
  it('refuses a frozen client instead of silently handing the real method through', () => {
    const { options } = quiet({ trigger: 'always', safetyGating: true });
    const create = vi.fn(async (params: unknown) => params);
    const frozen = Object.freeze({ chat: Object.freeze({ completions: { create } }) });
    expect(() => withCompaction(frozen, options)).toThrow(UnsupportedTargetError);
    expect(() => withCompaction(frozen, options)).toThrow(/'chat' is a non-configurable/);

    const innerFrozen = { chat: { completions: Object.freeze({ create }) } };
    expect(() => withCompaction(innerFrozen, options)).toThrow(/'chat\.completions\.create'/);

    const runnable = Object.freeze({ invoke: vi.fn(async (input: unknown) => input) });
    expect(() => withCompaction(runnable, options)).toThrow(UnsupportedTargetError);

    // Frozen things off the wrapped path are fine.
    const aside = { chat: { completions: { create } }, embeddings: Object.freeze({}) };
    expect(() => withCompaction(aside, options)).not.toThrow();
  });
});
