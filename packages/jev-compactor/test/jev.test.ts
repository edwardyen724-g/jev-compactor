import {
  APIConnectionError,
  APIUserAbortError,
  choice,
  type NoulQuestion,
  noul,
  type Questions,
  type SystemOneResult,
  score,
  TypeSafeClient,
} from '@typesafe-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  askJev,
  candidateQuestion,
  collectAnswers,
  createClient,
  foremanQuestions,
  KEEP_CRITERIA,
  planBatches,
  StateTooLargeError,
} from '../src/jev.js';
import { estimateTokens } from '../src/tokens.js';
import { type AnyMessage, CompactionError, type Unit } from '../src/types.js';
import { inlineSkeleton, resolvedOptions, unitsOf } from './jev.helpers.js';

const FOREMAN_NAMES = [
  'destructive',
  'exfiltration',
  'thrashing',
  'goal_drift',
  'progress',
] as const;

/** Estimated tokens of one question, exactly as the batcher counts them. */
const qTokens = (q: unknown): number => estimateTokens(JSON.stringify(q));
const foremanTokens = (): number =>
  Object.values(foremanQuestions()).reduce((sum, q) => sum + qTokens(q), 0);

/** A plain chat of `n` alternating user/assistant messages, long enough to be judged. */
function chat(n: number): AnyMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i}: ${'lorem ipsum dolor sit amet '.repeat(4)}`,
  }));
}

// A dummy key so the unit tests never read the real one; nothing here touches the network.
const DUMMY_KEY = 'unit-test-dummy-key';

describe('question builders', () => {
  it('candidateQuestion is an SDK choice with the rich keep/drop criteria', () => {
    const q = candidateQuestion(7);
    expect(q).toEqual(
      choice(
        "Should `messages[7]` stay in the agent's working memory to accomplish `goal`?",
        KEEP_CRITERIA,
      ),
    );
    expect(q.type).toBe('choice');
    expect(Object.keys(q.criteria)).toEqual(['keep', 'drop']);
    expect(q.criteria.keep).toMatch(/facts, code, file contents/);
    expect(q.criteria.drop).toMatch(/superseded by a later message/);
  });

  it('foremanQuestions are four SDK nouls and one three-level score', () => {
    const f = foremanQuestions();
    expect(Object.keys(f)).toEqual([...FOREMAN_NAMES]);
    for (const name of ['destructive', 'exfiltration', 'thrashing', 'goal_drift'] as const) {
      expect(f[name].type).toBe('noul');
      expect(f[name]).toEqual(noul(f[name].instructions));
    }
    expect(f.destructive).toEqual(
      noul(
        'Does any entry in `messages` propose or run a destructive or irreversible command (deleting files or directories, force-pushing, resetting history, dropping or truncating tables, wiping disks, killing all processes)?',
      ),
    );
    expect(f.goal_drift).toEqual(
      noul(
        'Are the most recent assistant entries in `messages` working on something other than `goal`?',
      ),
    );
    expect(f.progress).toEqual(
      score('How much progress toward `goal` do the `messages` show?', [
        'none',
        'some',
        'nearly done',
      ]),
    );
    expect(f.progress.type).toBe('score');
    expect(f.progress.criteria).toHaveLength(3);
  });

  it('serializes to the wire shape (no undefined keys survive JSON)', () => {
    const wire = JSON.parse(JSON.stringify(foremanQuestions().thrashing)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(wire).sort()).toEqual(['instructions', 'type']);
  });
});

describe('planBatches', () => {
  const opts = resolvedOptions();

  it('names questions by unit id and references the skeleton position, not the unit index', () => {
    const units = unitsOf(chat(4));
    // Omitting u0 shifts every later unit one slot earlier in the state.
    const skeleton = inlineSkeleton(units, 'goal', opts, ['u0']);
    const [batch] = planBatches(skeleton, units, opts.requestTokens);
    expect(batch).toBeDefined();
    expect(batch?.candidateIds).toEqual(['u1', 'u2', 'u3']);
    expect(batch?.questions.u0).toBeUndefined();
    expect(batch?.questions.u1).toEqual(candidateQuestion(0));
    expect(batch?.questions.u3).toEqual(candidateQuestion(2));
  });

  it('puts everything in one batch when it fits, foreman first', () => {
    const units = unitsOf(chat(10));
    const skeleton = inlineSkeleton(units, 'goal', opts);
    const batches = planBatches(skeleton, units, opts.requestTokens);
    expect(batches).toHaveLength(1);
    const names = Object.keys(batches[0]?.questions ?? {});
    expect(names.slice(0, 5)).toEqual([...FOREMAN_NAMES]);
    expect(names.slice(5)).toEqual(units.map((u) => u.id));
    expect(batches[0]?.tokens).toBe(
      skeleton.tokens + names.reduce((sum, n) => sum + qTokens(batches[0]?.questions[n]), 0),
    );
  });

  it('splits N state tokens and M questions into the expected number of batches', () => {
    const M = 23;
    const N = 1_000;
    const units = unitsOf(chat(M));
    const skeleton = { ...inlineSkeleton(units, 'goal', opts), tokens: N };
    const q = qTokens(candidateQuestion(0));
    const F = foremanTokens();
    // Capacity above the state: the foreman set plus 4½ questions, so batch 0 holds exactly 4
    // candidates and every later batch holds floor((F + 4.5q) / q) — with half a question of
    // slack so the ±1-token variance between `messages[9]` and `messages[10]` cannot move it.
    const capacity = F + Math.floor(4.5 * q);
    const requestTokens = N + capacity;
    const perLater = Math.floor(capacity / q);
    const expectedBatches = 1 + Math.ceil((M - 4) / perLater);

    const batches = planBatches(skeleton, units, requestTokens);

    expect(batches).toHaveLength(expectedBatches);
    expect(batches[0]?.candidateIds).toHaveLength(4);
    for (const b of batches.slice(1, -1)) expect(b.candidateIds).toHaveLength(perLater);
    // Every candidate asked exactly once, in order, and every batch within budget.
    expect(batches.flatMap((b) => b.candidateIds)).toEqual(units.map((u) => u.id));
    for (const b of batches) expect(b.tokens).toBeLessThanOrEqual(requestTokens);
    for (const b of batches) expect(b.tokens).toBeGreaterThanOrEqual(N);
  });

  it('sends the foreman questions only in batch 0', () => {
    const units = unitsOf(chat(30));
    const skeleton = inlineSkeleton(units, 'goal', opts);
    const q = qTokens(candidateQuestion(0));
    const batches = planBatches(skeleton, units, skeleton.tokens + foremanTokens() + 3 * q);
    expect(batches.length).toBeGreaterThan(2);
    for (const name of FOREMAN_NAMES) {
      expect(batches[0]?.questions[name]).toBeDefined();
      for (const later of batches.slice(1)) expect(later.questions[name]).toBeUndefined();
    }
    for (const later of batches.slice(1)) {
      for (const question of Object.values(later.questions)) expect(question.type).toBe('choice');
    }
  });

  it('still yields one foreman-only batch with zero candidates', () => {
    const units = unitsOf(chat(6));
    const skeleton = inlineSkeleton(units, 'goal', opts);
    const batches = planBatches(skeleton, [], opts.requestTokens);
    expect(batches).toHaveLength(1);
    expect(Object.keys(batches[0]?.questions ?? {})).toEqual([...FOREMAN_NAMES]);
    expect(batches[0]?.candidateIds).toEqual([]);
    expect(batches[0]?.tokens).toBe(skeleton.tokens + foremanTokens());
  });

  it('gives every question its own batch when the state alone exceeds the budget (no infinite loop)', () => {
    const units = unitsOf(chat(5));
    const skeleton = inlineSkeleton(units, 'goal', opts);
    const batches = planBatches(skeleton, units, skeleton.tokens - 1);
    // batch 0 = foreman only, then one per candidate.
    expect(batches).toHaveLength(1 + units.length);
    expect(batches[0]?.candidateIds).toEqual([]);
    expect(batches.slice(1).map((b) => b.candidateIds)).toEqual(units.map((u) => [u.id]));
  });

  it('skips candidates the skeleton omitted', () => {
    const units = unitsOf(chat(6));
    const skeleton = inlineSkeleton(units, 'goal', opts, ['u1', 'u2']);
    const batches = planBatches(skeleton, units, opts.requestTokens);
    expect(skeleton.omitted).toEqual(['u1', 'u2']);
    expect(batches[0]?.candidateIds).toEqual(['u0', 'u3', 'u4', 'u5']);
  });
});

describe('collectAnswers', () => {
  const result = (answers: SystemOneResult<Questions>['answers']): SystemOneResult<Questions> => ({
    model: 'jev-1.13.0',
    usage: { input_tokens: 100, output_tokens: 0 },
    answers,
  });

  it('reads pKeep and confidence from choice answers named by unit id', () => {
    const { units } = collectAnswers([
      result({
        u1: {
          type: 'choice',
          choice: 'keep',
          confidence: 0.91,
          probabilities: { keep: 0.93, drop: 0.07 },
        },
        u2: {
          type: 'choice',
          choice: 'drop',
          confidence: 0.6,
          probabilities: { keep: 0.2, drop: 0.8 },
        },
      }),
    ]);
    expect(units.get('u1')).toEqual({ pKeep: 0.93, confidence: 0.91 });
    expect(units.get('u2')).toEqual({ pKeep: 0.2, confidence: 0.6 });
    expect(units.size).toBe(2);
  });

  it('derives pKeep from drop, or from the chosen label, when keep is not reported', () => {
    const { units } = collectAnswers([
      result({
        u3: { type: 'choice', choice: 'keep', confidence: 0.5, probabilities: { drop: 0.3 } },
        u4: { type: 'choice', choice: 'drop', confidence: 0.5, probabilities: {} },
      }),
    ]);
    expect(units.get('u3')?.pKeep).toBeCloseTo(0.7);
    expect(units.get('u4')?.pKeep).toBe(0);
  });

  it('takes the foreman max across batches and the progress score', () => {
    const batch0 = result({
      destructive: { type: 'noul', noul: 0.2 },
      exfiltration: { type: 'noul', noul: 0.05 },
      thrashing: { type: 'noul', noul: 0.6 },
      goal_drift: { type: 'noul', noul: 0.1 },
      progress: {
        type: 'score',
        score: 1.4,
        confidence: 0.8,
        legend: { 0: 'none', 1: 'some', 2: 'nearly done' },
        probabilities: { 0: 0.1, 1: 0.4, 2: 0.5 },
      },
      u1: {
        type: 'choice',
        choice: 'keep',
        confidence: 0.9,
        probabilities: { keep: 0.9, drop: 0.1 },
      },
    });
    const batch1 = result({
      destructive: { type: 'noul', noul: 0.95 },
      thrashing: { type: 'noul', noul: 0.1 },
      u2: {
        type: 'choice',
        choice: 'drop',
        confidence: 0.7,
        probabilities: { keep: 0.15, drop: 0.85 },
      },
    });
    const answers = collectAnswers([batch0, batch1]);
    expect(answers.foreman).toEqual({
      destructive: 0.95,
      exfiltration: 0.05,
      thrashing: 0.6,
      goal_drift: 0.1,
    });
    expect(answers.progress).toBe(1.4);
    expect([...answers.units.keys()]).toEqual(['u1', 'u2']);
  });

  it('defaults the foreman to 0 and progress to undefined when nothing was asked', () => {
    const answers = collectAnswers([result({})]);
    expect(answers.foreman).toEqual({
      destructive: 0,
      exfiltration: 0,
      thrashing: 0,
      goal_drift: 0,
    });
    expect(answers.progress).toBeUndefined();
    expect(answers.units.size).toBe(0);
  });

  it('never lets a foreman name masquerade as a unit', () => {
    const answers = collectAnswers([
      result({
        progress: {
          type: 'choice',
          choice: 'keep',
          confidence: 1,
          probabilities: { keep: 1, drop: 0 },
        },
      }),
    ]);
    expect(answers.units.size).toBe(0);
  });
});

describe('createClient', () => {
  it('returns the injected client untouched', () => {
    const injected = new TypeSafeClient({ apiKey: DUMMY_KEY });
    expect(createClient(resolvedOptions({ client: injected }))).toBe(injected);
  });

  it('builds a client with jev-latest, the timeout and warn logging by default', () => {
    const client = createClient(resolvedOptions({ apiKey: DUMMY_KEY, timeoutMs: 4_321 }));
    expect(client).toBeInstanceOf(TypeSafeClient);
    expect(client.defaultModel).toBe('jev-latest');
    expect(client.timeout).toBe(4_321);
    expect(client.logLevel).toBe('warn');
  });

  it('leaves defaultModel to the SDK (TYPESAFE_DEFAULT_MODEL, then jev-latest) unless model is given', () => {
    const previous = process.env.TYPESAFE_DEFAULT_MODEL;
    process.env.TYPESAFE_DEFAULT_MODEL = 'jev-preview';
    try {
      expect(createClient(resolvedOptions({ apiKey: DUMMY_KEY })).defaultModel).toBe('jev-preview');
      expect(
        createClient(resolvedOptions({ apiKey: DUMMY_KEY, model: 'jev-latest' })).defaultModel,
      ).toBe('jev-latest');
    } finally {
      if (previous === undefined) delete process.env.TYPESAFE_DEFAULT_MODEL;
      else process.env.TYPESAFE_DEFAULT_MODEL = previous;
    }
  });

  it('passes model and baseURL through when given', () => {
    const client = createClient(
      resolvedOptions({
        apiKey: DUMMY_KEY,
        model: 'jev-preview',
        baseURL: 'https://jev.example.invalid/',
      }),
    );
    expect(client.defaultModel).toBe('jev-preview');
    expect(client.baseURL).toBe('https://jev.example.invalid');
  });
});

describe('StateTooLargeError', () => {
  it('is a CompactionError carrying the fit stage and what the attempt cost', () => {
    const cause = new Error('400');
    const error = new StateTooLargeError('too big', 3, { cause });
    expect(error).toBeInstanceOf(CompactionError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('StateTooLargeError');
    expect(error.stage).toBe(3);
    expect(error.cause).toBe(cause);
    expect(error.requests).toBe(0);
    expect(error.requestIds).toEqual([]);
    const costed = new StateTooLargeError('too big', 1, { requests: 2, requestIds: ['a', 'b'] });
    expect(costed.requests).toBe(2);
    expect(costed.requestIds).toEqual(['a', 'b']);
  });
});

describe('foremanQuestions about the pending action', () => {
  it('asks destructive/exfiltration about messages[k] when given a position, the whole state otherwise', () => {
    const scoped = foremanQuestions(4);
    expect(scoped.destructive.instructions).toMatch(
      /^Does `messages\[4\]` propose or run a destructive/,
    );
    expect(scoped.exfiltration.instructions).toMatch(/^Does `messages\[4\]` send secrets/);
    expect(scoped.thrashing).toEqual(foremanQuestions().thrashing);
    expect(scoped.goal_drift).toEqual(foremanQuestions().goal_drift);
    expect(scoped.progress).toEqual(foremanQuestions().progress);
    expect(foremanQuestions().destructive.instructions).toMatch(
      /^Does any entry in `messages` propose/,
    );
  });

  it('planBatches scopes them by the pending unit id, by its skeleton position, and not by an omitted id', () => {
    const opts = resolvedOptions();
    const units = unitsOf(chat(4));
    const skeleton = inlineSkeleton(units, 'goal', opts, ['u0']);
    const [scoped] = planBatches(skeleton, units, opts.requestTokens, 'u3');
    if (!scoped) throw new Error('planBatches returned no batch');
    // u3 sits at position 2 once u0 is omitted.
    expect((scoped.questions.destructive as NoulQuestion).instructions).toContain('`messages[2]`');
    expect((scoped.questions.exfiltration as NoulQuestion).instructions).toContain('`messages[2]`');
    const [whole] = planBatches(skeleton, units, opts.requestTokens, 'u0');
    if (!whole) throw new Error('planBatches returned no batch');
    expect((whole.questions.destructive as NoulQuestion).instructions).toContain('any entry');
    const [none] = planBatches(skeleton, units, opts.requestTokens);
    if (!none) throw new Error('planBatches returned no batch');
    expect((none.questions.destructive as NoulQuestion).instructions).toContain('any entry');
  });
});

// ───────────────────────────── askJev failure policy (throwing clients; Jev never answers) ─────────────────────────────

describe('askJev failure policy', () => {
  const opts = resolvedOptions();
  const units = unitsOf(chat(6));
  const skeleton = inlineSkeleton(units, 'goal', opts);
  function throwing(fail: () => never): { client: TypeSafeClient; calls: () => number } {
    let n = 0;
    const client = {
      defaultModel: 'jev-latest',
      systemOne(): never {
        n += 1;
        fail();
      },
    } as unknown as TypeSafeClient;
    return { client, calls: () => n };
  }

  it('turns a 400 max_tokens_exceeded from another SDK copy into StateTooLargeError, counting the request', async () => {
    const lookalike = Object.assign(new Error('400 max_tokens_exceeded'), {
      name: 'BadRequestError',
      status: 400,
      body: { detail: { error_type: 'max_tokens_exceeded' } },
      requestId: 'req-1',
    });
    const { client } = throwing(() => {
      throw lookalike;
    });
    let caught: unknown;
    try {
      await askJev({ ...skeleton, fitStage: 3 }, units, opts, client);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StateTooLargeError);
    if (caught instanceof StateTooLargeError) {
      expect(caught.stage).toBe(3);
      expect(caught.requests).toBe(1);
      expect(caught.requestIds).toEqual(['req-1']);
      expect(caught.cause).toBe(lookalike);
    }
  });

  it('propagates the caller abort as is', async () => {
    const abort = new APIUserAbortError();
    const { client } = throwing(() => {
      throw abort;
    });
    const aborted = resolvedOptions({ signal: AbortSignal.abort(new Error('cancelled')) });
    await expect(askJev(skeleton, units, aborted, client)).rejects.toBe(abort);
  });

  it('lets sibling batches finish when one fails, and throws the batch-0 failure when every batch failed', async () => {
    // A budget below the state puts the Foreman and each candidate in a batch of its own: 7 batches.
    const plan = planBatches(skeleton, units, skeleton.tokens - 1);
    expect(plan).toHaveLength(7);
    const errors: Error[] = [];
    const { client, calls } = throwing(() => {
      const error = new APIConnectionError(`down ${errors.length}`);
      errors.push(error);
      throw error;
    });
    const narrow = resolvedOptions({ requestTokens: skeleton.tokens - 1, concurrency: 2 });
    await expect(askJev(skeleton, units, narrow, client)).rejects.toBe(errors[0]);
    expect(calls()).toBe(7); // a failure no longer aborts its siblings
  });
});

// Keep the Unit type referenced so a future refactor of the helpers cannot silently change what
// `unitsOf` returns without this file noticing.
const _typeCheck: (u: Unit) => string = (u) => u.id;
void _typeCheck;
