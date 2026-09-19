/**
 * engine.ts — pure paths only. No network and no mocked Jev: every test that reaches the Jev
 * stage injects a client whose `systemOne` throws, which both proves when Jev is (not) touched
 * and exercises the fail-open / fail-closed policy with the SDK's real error classes.
 */
import {
  APIConnectionError,
  APIUserAbortError,
  BadRequestError,
  type TypeSafeClient,
} from '@typesafe-ai/sdk';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CORRECTIVE } from '../src/decide.js';
import { compact, createCompactor, DEFAULTS, resolveOptions } from '../src/engine.js';
import { DEFAULT_PATTERNS } from '../src/prepass.js';
import { estimateTokens, messagesTokens } from '../src/tokens.js';
import {
  type AnyMessage,
  type CompactionReport,
  CompactionUnavailableError,
  type EscrowVerdict,
  type ForemanFinding,
  type ForemanPattern,
  type SkeletonState,
} from '../src/types.js';
import { loadFixture } from './jev.helpers.js';

// ───────────────────────────── helpers ─────────────────────────────

/** A client whose only method throws `error`; `calls()` counts how often Jev was "reached". */
function throwingClient(error: unknown): { client: TypeSafeClient; calls: () => number } {
  let n = 0;
  const client = {
    defaultModel: 'jev-latest',
    systemOne(): never {
      n += 1;
      throw error;
    },
  } as unknown as TypeSafeClient;
  return { client, calls: () => n };
}

const CONNECTION_ERROR = (): APIConnectionError =>
  new APIConnectionError('connect ECONNREFUSED 127.0.0.1:443');

/** A short chat where every unit is pinned (system + the last `keepRecent`), so Jev has nothing to judge. */
const SHORT_CHAT: AnyMessage[] = [
  { role: 'system', content: 'You are a shell assistant.' },
  { role: 'user', content: 'Clean the build directory please.' },
  { role: 'assistant', content: 'Running `rm -rf /srv/app/build` now.' },
];

function expectSameObjects(actual: readonly AnyMessage[], expected: readonly AnyMessage[]): void {
  expect(actual).toHaveLength(expected.length);
  for (const [i, message] of actual.entries()) expect(message).toBe(expected[i]);
}

// ───────────────────────────── resolveOptions ─────────────────────────────

describe('resolveOptions', () => {
  it('applies every documented default in compact mode', () => {
    const opts = resolveOptions(undefined, 'compact');
    expect(opts.trigger).toBe('always');
    expect(opts.maxTokens).toBe(15_000);
    expect(opts.keepRecent).toBe(4);
    expect(opts.pinCodeWithin).toBe(12);
    expect(opts.dropThreshold).toBe(0.7);
    expect(opts.dropThresholdSecondPass).toBe(0.5);
    expect(opts.minKeep).toBe(2);
    expect(opts.allowTruncate).toBe(false);
    expect(opts.truncateHeadChars).toBe(300);
    expect(opts.excerptChars).toBe(1_500);
    expect(opts.stateTokens).toBe(20_000);
    expect(opts.requestTokens).toBe(56_000);
    expect(opts.concurrency).toBe(8);
    expect(opts.safetyGating).toBe(false);
    expect(opts.reviewThreshold).toBe(0.35);
    expect(opts.actionThreshold).toBe(0.7);
    expect(opts.failClosed).toBe(false);
    expect(opts.timeoutMs).toBe(10_000);
    expect(opts.format).toBe('auto');
    expect(opts.countTokens).toBe(estimateTokens);
    expect(opts.patterns).toBe(DEFAULT_PATTERNS);
    expect(opts.correctivePrompts).toEqual(DEFAULT_CORRECTIVE);
    for (const key of [
      'goal',
      'pin',
      'client',
      'apiKey',
      'model',
      'baseURL',
      'signal',
      'onReport',
      'onEscrow',
    ] as const) {
      expect(opts[key]).toBeUndefined();
    }
  });

  it('mirrors DEFAULTS', () => {
    const opts = resolveOptions(undefined, 'compact');
    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (key === 'cooldownTurns') continue; // withCompaction only
      expect(opts[key as keyof typeof opts], key).toBe(value);
    }
    expect(DEFAULTS.cooldownTurns).toBe(1);
    expect(Object.isFrozen(DEFAULTS)).toBe(true);
  });

  it('defaults trigger to auto in wrap mode and honors an explicit trigger in both modes', () => {
    expect(resolveOptions(undefined, 'wrap').trigger).toBe('auto');
    expect(resolveOptions({ trigger: 'always' }, 'wrap').trigger).toBe('always');
    expect(resolveOptions({ trigger: 'auto' }, 'compact').trigger).toBe('auto');
  });

  it('passes DEFAULT_PATTERNS to a patterns function and takes an array as the full list', () => {
    const extra: ForemanPattern = { name: 'custom', kind: 'destructive', regex: /nuke/i };
    let received: readonly ForemanPattern[] | undefined;
    const fromFn = resolveOptions(
      {
        patterns: (defaults) => {
          received = defaults;
          return [...defaults, extra];
        },
      },
      'compact',
    );
    expect(received).toBe(DEFAULT_PATTERNS);
    expect(fromFn.patterns).toHaveLength(DEFAULT_PATTERNS.length + 1);
    expect(fromFn.patterns.at(-1)).toBe(extra);

    const fromArray = resolveOptions({ patterns: [extra] }, 'compact');
    expect(fromArray.patterns).toEqual([extra]);
  });

  it('merges correctivePrompts over the defaults and keeps false as false', () => {
    const merged = resolveOptions({ correctivePrompts: { thrashing: 'Stop it.' } }, 'compact');
    expect(merged.correctivePrompts).toEqual({ ...DEFAULT_CORRECTIVE, thrashing: 'Stop it.' });
    expect(resolveOptions({ correctivePrompts: false }, 'compact').correctivePrompts).toBe(false);
  });

  it('keeps explicit values and pass-through callbacks', () => {
    const pin = (): boolean => false;
    const countTokens = (t: string): number => t.length;
    const opts = resolveOptions(
      {
        maxTokens: 999,
        keepRecent: 1,
        goal: 'g',
        pin,
        countTokens,
        format: 'openai',
        model: 'jev-preview',
      },
      'compact',
    );
    expect(opts.maxTokens).toBe(999);
    expect(opts.keepRecent).toBe(1);
    expect(opts.goal).toBe('g');
    expect(opts.pin).toBe(pin);
    expect(opts.countTokens).toBe(countTokens);
    expect(opts.format).toBe('openai');
    expect(opts.model).toBe('jev-preview');
  });
});

// ───────────────────────────── trigger ─────────────────────────────

describe('compact — trigger', () => {
  it("skips below_threshold with trigger 'auto' and never touches Jev", async () => {
    const messages = loadFixture('openai-tool-loop.json');
    const { client, calls } = throwingClient(CONNECTION_ERROR());
    const result = await compact(messages, { trigger: 'auto', maxTokens: 10_000, client });

    expect(calls()).toBe(0);
    expect(result.compacted).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.report.skipped).toBe('below_threshold');
    expect(result.messages).not.toBe(messages);
    expectSameObjects(result.messages, messages);
    expect(result.report.tokensBefore).toBe(messagesTokens(messages));
    expect(result.report.tokensAfter).toBe(result.report.tokensBefore);
    expect(result.report.messagesBefore).toBe(messages.length);
    expect(result.report.messagesAfter).toBe(messages.length);
    expect(result.report.format).toBe('openai');
    expect(result.report.units).toEqual([]);
    // The regex floor is unconditional: the fixture's rm -rf proposal (message 11) is still reported.
    expect(result.report.foreman).toMatchObject([
      { kind: 'destructive', source: 'pattern', level: 'action', indices: [11] },
    ]);
    expect(result.report.jev).toBeUndefined();
  });

  it('gates a below-threshold history when safetyGating is on, without touching Jev', async () => {
    const { client, calls } = throwingClient(CONNECTION_ERROR());
    const gated = await compact(SHORT_CHAT, { trigger: 'auto', safetyGating: true, client });
    expect(calls()).toBe(0);
    expect(gated.report.skipped).toBe('below_threshold');
    expect(gated.blocked).toBe(true);
    expect(gated.report.foreman).toMatchObject([{ kind: 'destructive', indices: [2] }]);
    expectSameObjects(gated.messages, SHORT_CHAT);
  });

  it("runs with trigger 'auto' once the estimate exceeds maxTokens", async () => {
    const messages = loadFixture('openai-tool-loop.json');
    const { client, calls } = throwingClient(CONNECTION_ERROR());
    const result = await compact(messages, { trigger: 'auto', maxTokens: 1_000, client });
    expect(calls()).toBe(1);
    expect(result.report.skipped).toBe('jev_unavailable');
  });

  it('uses a caller-supplied countTokens for the estimate', async () => {
    const messages = loadFixture('openai-tool-loop.json');
    const { client, calls } = throwingClient(CONNECTION_ERROR());
    const countTokens = (t: string): number => t.length;
    const result = await compact(messages, {
      trigger: 'auto',
      maxTokens: 1e9,
      countTokens,
      client,
    });
    expect(calls()).toBe(0);
    expect(result.report.tokensBefore).toBe(messagesTokens(messages, countTokens));
    expect(result.report.tokensBefore).toBeGreaterThan(messagesTokens(messages));
  });
});

// ───────────────────────────── nothing_to_judge ─────────────────────────────

describe('compact — nothing_to_judge', () => {
  it('skips when every unit is pinned, still applying pins and the regex Foreman', async () => {
    const { client, calls } = throwingClient(CONNECTION_ERROR());
    const reports: CompactionReport[] = [];
    const result = await compact(SHORT_CHAT, { client, onReport: (r) => reports.push(r) });

    expect(calls()).toBe(0);
    expect(result.compacted).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.report.skipped).toBe('nothing_to_judge');
    expectSameObjects(result.messages, SHORT_CHAT);
    expect(result.report.goal).toBe('Clean the build directory please.');

    expect(result.report.units.map((u) => u.decision)).toEqual(['pinned', 'pinned', 'flagged']);
    expect(result.report.units[0]?.reason).toBe('pinned:system');
    expect(result.report.units[2]?.reason).toMatch(
      /^flagged:destructive rm-recursive: rm -rf \/srv\/app\/build/,
    );

    expect(result.report.foreman).toHaveLength(1);
    const finding = result.report.foreman[0] as ForemanFinding;
    expect(finding).toMatchObject({
      kind: 'destructive',
      source: 'pattern',
      level: 'action',
      probability: 1,
      indices: [2],
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]).toBe(result.report);
  });

  it('returns an empty array for empty input', async () => {
    const { client, calls } = throwingClient(CONNECTION_ERROR());
    const result = await compact([], { client });
    expect(calls()).toBe(0);
    expect(result.messages).toEqual([]);
    expect(result.report.skipped).toBe('nothing_to_judge');
    expect(result.report.tokensBefore).toBe(0);
    expect(result.report.goal).toBe('');
  });

  it('still asks Jev (for the Foreman) when safetyGating is on', async () => {
    const { client, calls } = throwingClient(CONNECTION_ERROR());
    const result = await compact(SHORT_CHAT, { client, safetyGating: true });
    expect(calls()).toBe(1);
    expect(result.report.skipped).toBe('jev_unavailable');
    // The regex floor does not need Jev: the rm -rf blocks anyway.
    expect(result.blocked).toBe(true);
  });
});

// ───────────────────────────── fail-open / fail-closed ─────────────────────────────

describe('compact — Jev unavailable', () => {
  it('fails open: the original array comes back unchanged with pattern findings and a report', async () => {
    const messages = loadFixture('openai-tool-loop.json');
    const error = CONNECTION_ERROR();
    const { client, calls } = throwingClient(error);
    const reports: CompactionReport[] = [];
    const result = await compact(messages, { client, onReport: (r) => reports.push(r) });

    expect(calls()).toBe(1);
    expect(result.compacted).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.systemAddendum).toBeUndefined();
    expectSameObjects(result.messages, messages);

    const { report } = result;
    expect(report.skipped).toBe('jev_unavailable');
    expect(report.error).toBe(error.message);
    expect(report.jev).toBeUndefined();
    expect(report.progress).toBeUndefined();
    expect(report.tokensAfter).toBe(report.tokensBefore);
    expect(report.messagesAfter).toBe(messages.length);
    expect(report.latencyMs).toBeGreaterThanOrEqual(0);

    // Pattern findings are still present: the assistant proposes `rm -rf ./src` at index 11.
    expect(report.foreman).toHaveLength(1);
    expect(report.foreman[0]).toMatchObject({
      kind: 'destructive',
      source: 'pattern',
      level: 'action',
      indices: [11],
    });
    const flagged = report.units.find((u) => u.indices.includes(11));
    expect(flagged?.decision).toBe('flagged');

    // Every message is accounted for and nothing claims a drop.
    const covered = report.units.flatMap((u) => u.indices).sort((a, b) => a - b);
    expect(covered).toEqual(messages.map((_, i) => i));
    for (const unit of report.units) expect(['kept', 'pinned', 'flagged']).toContain(unit.decision);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toBe(report);
  });

  it('fails open on an APIConnectionError-like error from another SDK copy', async () => {
    const messages = loadFixture('openai-tool-loop.json');
    const lookalike = Object.assign(new Error('socket hang up'), { name: 'APITimeoutError' });
    const { client } = throwingClient(lookalike);
    const result = await compact(messages, { client });
    expect(result.report.skipped).toBe('jev_unavailable');
    expect(result.report.error).toBe('socket hang up');
    expectSameObjects(result.messages, messages);
  });

  it('reports exact duplicates as kept when failing open, since they are returned too', async () => {
    const messages = loadFixture('plain-chat.json');
    const { client } = throwingClient(CONNECTION_ERROR());
    const result = await compact(messages, { client });
    expectSameObjects(result.messages, messages);
    const duplicate = result.report.units.find((u) => u.reason.includes('duplicate of'));
    expect(duplicate).toBeDefined();
    expect(duplicate?.decision).toBe('kept');
    expect(duplicate?.reason).toMatch(/^jev:unavailable \(was duplicate of u\d+\)$/);
  });

  it('throws CompactionUnavailableError with the cause when failClosed is set', async () => {
    const messages = loadFixture('openai-tool-loop.json');
    const error = CONNECTION_ERROR();
    const { client } = throwingClient(error);
    let caught: unknown;
    try {
      await compact(messages, { client, failClosed: true });
    } catch (e: unknown) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CompactionUnavailableError);
    if (caught instanceof CompactionUnavailableError) {
      expect(caught.cause).toBe(error);
      expect(caught.message).toContain('ECONNREFUSED');
    }
  });

  it('propagates errors that are not Jev failures', async () => {
    const messages = loadFixture('openai-tool-loop.json');
    const bug = new Error('boom');
    const { client } = throwingClient(bug);
    await expect(compact(messages, { client })).rejects.toBe(bug);
  });
});

// ───────────────────────────── safety gating & escrow ─────────────────────────────

describe('compact — safetyGating', () => {
  /** The openai fixture cut right after the assistant proposes `rm -rf ./src` (message 11), so the proposal is the pending action. */
  const proposal = (): AnyMessage[] => loadFixture('openai-tool-loop.json').slice(0, 12);

  it('blocks on an action-level pattern finding about the pending action, only when safetyGating is on', async () => {
    const messages = proposal();
    const { client } = throwingClient(CONNECTION_ERROR());
    const open = await compact(messages, { client });
    expect(open.blocked).toBe(false);
    const gated = await compact(messages, { client, safetyGating: true });
    expect(gated.blocked).toBe(true);
    expect(gated.report.foreman[0]).toMatchObject({
      kind: 'destructive',
      source: 'pattern',
      indices: [11],
    });
  });

  it('does not block on a proposal the conversation has moved past, but still reports and flags it', async () => {
    // In the full fixture the user rejects the rm -rf at message 12 and the session goes on for 22 more.
    const messages = loadFixture('openai-tool-loop.json');
    const { client } = throwingClient(CONNECTION_ERROR());
    const result = await compact(messages, { client, safetyGating: true });
    expect(result.blocked).toBe(false);
    expect(result.report.foreman).toMatchObject([
      { kind: 'destructive', source: 'pattern', level: 'action', indices: [11] },
    ]);
    expect(result.report.units.find((u) => u.indices.includes(11))?.decision).toBe('flagged');
  });

  it("does not block on the user's own warning, nor on a command a tool result merely quotes", async () => {
    const { client } = throwingClient(CONNECTION_ERROR());
    const warning: AnyMessage[] = [
      {
        role: 'user',
        content: 'Never run rm -rf on prod, it wiped a box last week. Now fix src/auth.ts.',
      },
    ];
    const warned = await compact(warning, { client, safetyGating: true });
    expect(warned.blocked).toBe(false);
    expect(warned.report.foreman).toHaveLength(1); // reported all the same

    // The loop's usual shape: the wrapper is called right after the tool result comes back.
    const readme: AnyMessage[] = [
      { role: 'user', content: 'read the README' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'bash', arguments: '{"command":"cat README.md"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'c1',
        content: '# Setup\n\nTo clean: `rm -rf ./build` then `npm run build`.',
      },
    ];
    const read = await compact(readme, { client, safetyGating: true });
    expect(read.blocked).toBe(false);
    expect(read.report.foreman).toMatchObject([{ kind: 'destructive', indices: [2] }]); // the result, not the call
    expect(read.report.units[1]?.decision).toBe('flagged');

    // The same command in the agent's own call is the pending action and blocks.
    const ran: AnyMessage[] = [
      readme[0] as AnyMessage,
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c2',
            type: 'function',
            function: { name: 'bash', arguments: '{"command":"rm -rf ./build"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c2', content: '' },
    ];
    const blocked = await compact(ran, { client, safetyGating: true });
    expect(blocked.blocked).toBe(true);
    expect(blocked.report.foreman).toMatchObject([{ kind: 'destructive', indices: [1] }]);
  });

  it('calls onEscrow with the finding about the pending action; approve unblocks, block keeps the block', async () => {
    const messages = proposal();
    const { client } = throwingClient(CONNECTION_ERROR());
    const seen: ForemanFinding[] = [];
    const approved = await compact(messages, {
      client,
      safetyGating: true,
      onEscrow: (finding, result) => {
        seen.push(finding);
        expect(result.blocked).toBe(true);
        return 'approve';
      },
    });
    expect(approved.blocked).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'destructive', level: 'action', indices: [11] });

    const blocked = await compact(messages, {
      client,
      safetyGating: true,
      onEscrow: (): Promise<EscrowVerdict> => Promise.resolve('block'),
    });
    expect(blocked.blocked).toBe(true);
  });

  it('keeps the block when onEscrow throws or rejects: an escrow that cannot answer cannot approve', async () => {
    const messages = proposal();
    const { client } = throwingClient(CONNECTION_ERROR());
    const reports: CompactionReport[] = [];
    const thrown = await compact(messages, {
      client,
      safetyGating: true,
      onReport: (r) => reports.push(r),
      onEscrow: () => {
        throw new Error('escrow service down');
      },
    });
    expect(thrown.blocked).toBe(true);
    expect(reports).toHaveLength(1);
    const rejected = await compact(messages, {
      client,
      safetyGating: true,
      onEscrow: () => Promise.reject(new Error('escrow service down')),
    });
    expect(rejected.blocked).toBe(true);
  });
});

// ───────────────────────────── caller abort ─────────────────────────────

describe('compact — caller abort', () => {
  const ABORTED = (): AbortSignal => AbortSignal.abort(new Error('caller cancelled'));

  it('rejects with the abort error instead of failing open, with or without failClosed', async () => {
    const messages = loadFixture('openai-tool-loop.json');
    const abort = new APIUserAbortError();
    const { client } = throwingClient(abort);
    await expect(compact(messages, { client, signal: ABORTED() })).rejects.toBe(abort);
    await expect(compact(messages, { client, signal: ABORTED(), failClosed: true })).rejects.toBe(
      abort,
    );
  });

  it('propagates an abort raised by a client from another SDK copy', async () => {
    const messages = loadFixture('openai-tool-loop.json');
    const lookalike = Object.assign(new Error('Request was aborted.'), {
      name: 'APIUserAbortError',
    });
    const { client } = throwingClient(lookalike);
    await expect(compact(messages, { client, signal: ABORTED() })).rejects.toBe(lookalike);
  });

  it('still fails open on a connection error when the signal is not aborted', async () => {
    const messages = loadFixture('openai-tool-loop.json');
    const { client } = throwingClient(CONNECTION_ERROR());
    const result = await compact(messages, { client, signal: new AbortController().signal });
    expect(result.report.skipped).toBe('jev_unavailable');
  });
});

// ───────────────────────────── re-abridge ladder ─────────────────────────────

describe('compact — re-abridge ladder', () => {
  /** Rejects every state as too large, the way Jev does (HTTP 400 max_tokens_exceeded), recording each state it saw. */
  function rejectingClient(makeError: () => unknown): {
    client: TypeSafeClient;
    states: SkeletonState[];
  } {
    const states: SkeletonState[] = [];
    const client = {
      defaultModel: 'jev-latest',
      systemOne(request: { state: SkeletonState }): never {
        states.push(request.state);
        throw makeError();
      },
    } as unknown as TypeSafeClient;
    return { client, states };
  }
  const sdkError = (): BadRequestError =>
    new BadRequestError(400, { detail: { error_type: 'max_tokens_exceeded' } }, new Headers());
  const lookalikeError = (): Error =>
    Object.assign(new Error('400 max_tokens_exceeded'), {
      name: 'BadRequestError',
      status: 400,
      body: { detail: { error_type: 'max_tokens_exceeded' } },
    });

  it.each([
    ['the SDK class', sdkError],
    ['a look-alike from another SDK copy', lookalikeError],
  ])(
    'tightens the state on every rejection (%s) until candidates are omitted, then fails open',
    async (_label, makeError) => {
      const messages = loadFixture('plain-chat.json');
      const { client, states } = rejectingClient(makeError);
      const result = await compact(messages, { client, goal: 'Confirm the fix in src/auth.ts' });

      expect(result.report.skipped).toBe('jev_unavailable');
      expect(result.report.error).toMatch(/too large/);
      expectSameObjects(result.messages, messages);

      // Every rebuild is strictly smaller than the state Jev refused, so the ladder cannot spin on the
      // same state; it ends by omitting candidates (stage 5) although the estimate said the state fit.
      expect(states.length).toBeGreaterThanOrEqual(3);
      expect(states.length).toBeLessThanOrEqual(8);
      for (let i = 1; i < states.length; i++) {
        expect(JSON.stringify(states[i]).length).toBeLessThan(JSON.stringify(states[i - 1]).length);
      }
      const first = states[0] as SkeletonState;
      const last = states[states.length - 1] as SkeletonState;
      expect(last.messages.length).toBeLessThan(first.messages.length);
    },
  );
});

// ───────────────────────────── createCompactor ─────────────────────────────

describe('createCompactor', () => {
  it('resolves options once, shares the injected client and accepts per-call overrides', async () => {
    const messages = loadFixture('openai-tool-loop.json');
    const { client, calls } = throwingClient(CONNECTION_ERROR());
    const compactor = createCompactor({ maxTokens: 10_000, client });

    expect(compactor.options.trigger).toBe('always');
    expect(compactor.options.maxTokens).toBe(10_000);
    expect(compactor.client).toBe(client);

    const skipped = await compactor.compact(messages, { trigger: 'auto' });
    expect(skipped.report.skipped).toBe('below_threshold');
    expect(calls()).toBe(0);
    expect(compactor.options.trigger).toBe('always'); // overrides do not leak

    const ran = await compactor.compact(messages);
    expect(ran.report.skipped).toBe('jev_unavailable');
    expect(calls()).toBe(1);
    expectSameObjects(ran.messages, messages);
  });

  it('does not build a client until one is needed', async () => {
    // No client, no key needed: the below-threshold path never reaches Jev.
    const compactor = createCompactor({ trigger: 'auto', maxTokens: 1e9 });
    const result = await compactor.compact(SHORT_CHAT);
    expect(result.report.skipped).toBe('below_threshold');
  });
});
