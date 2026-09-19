/**
 * `status()` / `isWrapped()` / `verbose`: the wiring feedback of `withCompaction`. Offline — every
 * call stays under a huge `maxTokens`, so the wrapper passes through (`below_threshold`) or blocks
 * on the regex floor without touching Jev.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type AnyMessage, CompactionBlockedError } from '../src/types.js';
import { isWrapped, STATUS, status, withCompaction } from '../src/with-compaction.js';
import { fixture } from './bin.helpers.js';

const messages: AnyMessage[] = JSON.parse(readFileSync(fixture('openai-tool-loop.json'), 'utf8'));
const BIG = { maxTokens: 1_000_000_000 };

type Params = { messages: AnyMessage[] };

describe('status()', () => {
  it('is undefined for anything that did not come out of withCompaction', () => {
    expect(status(undefined)).toBeUndefined();
    expect(status(null)).toBeUndefined();
    expect(status({})).toBeUndefined();
    expect(status(() => 1)).toBeUndefined();
    expect(isWrapped({ chat: { completions: { create: () => 0 } } })).toBe(false);
  });

  it('reports a function wrapper, counts pass-throughs, and logs one line per call', async () => {
    const lines: string[] = [];
    const fn = withCompaction(async (m: AnyMessage[]) => m.length, {
      ...BIG,
      verbose: (line) => lines.push(line),
    });
    expect(status(fn)).toMatchObject({
      wrapped: true,
      shape: 'function',
      trigger: 'auto',
      maxTokens: BIG.maxTokens,
      safetyGating: false,
      cooldownTurns: 1,
      calls: 0,
      compactions: 0,
      blocked: 0,
    });
    expect(status(fn)?.lastReport).toBeUndefined();
    expect(await fn(messages)).toBe(messages.length);
    expect(await fn(messages)).toBe(messages.length);
    const s = status(fn);
    expect(s?.calls).toBe(2);
    expect(s?.skipped).toEqual({
      below_threshold: 2,
      cooldown: 0,
      nothing_to_judge: 0,
      jev_unavailable: 0,
    });
    expect(s?.compactions).toBe(0);
    expect(s?.lastReport?.skipped).toBe('below_threshold');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^jev-compactor: kept \d+\/\d+ messages · .* · skipped: below_threshold$/,
    );
    expect(isWrapped(fn)).toBe(true);
  });

  it('reports the OpenAI, Anthropic and LangChain shapes through the proxy', async () => {
    const openai = withCompaction(
      { chat: { completions: { create: async (p: Params) => p.messages.length } } },
      BIG,
    );
    const anthropic = withCompaction(
      { messages: { create: async (p: Params) => p.messages.length } },
      BIG,
    );
    const langchain = withCompaction(
      {
        invoke: async (input: AnyMessage[] | Params) =>
          (Array.isArray(input) ? input : input.messages).length,
      },
      BIG,
    );
    expect(status(openai)?.shape).toBe('openai');
    expect(status(anthropic)?.shape).toBe('anthropic');
    expect(status(langchain)?.shape).toBe('langchain');
    expect(await openai.chat.completions.create({ messages })).toBe(messages.length);
    expect(await anthropic.messages.create({ messages })).toBe(messages.length);
    expect(await langchain.invoke({ messages })).toBe(messages.length);
    expect(await langchain.invoke(messages)).toBe(messages.length);
    expect(status(openai)?.calls).toBe(1);
    expect(status(anthropic)?.calls).toBe(1);
    expect(status(langchain)?.calls).toBe(2);
    // The status lives on the wrapper, not on the client it wraps.
    const raw = { chat: { completions: { create: async (p: Params) => p.messages.length } } };
    const wrapped = withCompaction(raw, BIG);
    expect((wrapped as unknown as Record<symbol, unknown>)[STATUS]).toBeDefined();
    expect((raw as unknown as Record<symbol, unknown>)[STATUS]).toBeUndefined();
    expect(isWrapped(raw)).toBe(false);
  });

  it('counts a blocked call', async () => {
    const at = messages.findIndex(
      (m) => typeof m.content === 'string' && m.content.includes('rm -rf'),
    );
    expect(at).toBeGreaterThan(0);
    const pending = messages.slice(0, at + 1);
    const fn = withCompaction(async (m: AnyMessage[]) => m.length, { ...BIG, safetyGating: true });
    await expect(fn(pending)).rejects.toBeInstanceOf(CompactionBlockedError);
    expect(status(fn)).toMatchObject({ calls: 1, blocked: 1, compactions: 0 });
    expect(status(fn)?.lastReport?.foreman.some((f) => f.kind === 'destructive')).toBe(true);
  });
});
