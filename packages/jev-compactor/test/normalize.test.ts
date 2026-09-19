import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  actionIndices,
  defaultGoal,
  detectFormat,
  groupUnits,
  normalize,
  pendingUnit,
} from '../src/normalize.js';
import { messageTokens } from '../src/tokens.js';
import type { AnyMessage, Frame, MessageFormat, Unit } from '../src/types.js';

type FixtureName = 'openai-tool-loop' | 'anthropic-tool-loop' | 'langchain' | 'plain-chat';

function loadFixture(name: FixtureName): AnyMessage[] {
  const url = new URL(`../fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as AnyMessage[];
}

const FIXTURES: ReadonlyArray<[FixtureName, MessageFormat]> = [
  ['openai-tool-loop', 'openai'],
  ['anthropic-tool-loop', 'anthropic'],
  ['langchain', 'langchain'],
  ['plain-chat', 'plain'],
];

const FAIL_MARKER = 'Tests  1 failed | 2 passed (3)';
const AUTH_TS_MARKER = 'const CLOCK_SKEW_MS = 60_000;';

function frames(messages: AnyMessage[], format: MessageFormat | 'auto' = 'auto'): Frame[] {
  return normalize(messages, format).frames;
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}
const frame = must<Frame>;

// ───────────────────────────── detectFormat ─────────────────────────────

describe('detectFormat', () => {
  it.each(FIXTURES)('detects %s as %s', (name, format) => {
    expect(detectFormat(loadFixture(name))).toBe(format);
  });

  it('is plain for an empty array and for role/content messages', () => {
    expect(detectFormat([])).toBe('plain');
    expect(
      detectFormat([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]),
    ).toBe('plain');
  });

  it('is openai when any message has tool_calls, tool_call_id or role tool', () => {
    expect(detectFormat([{ role: 'assistant', content: null, tool_calls: [] }])).toBe('openai');
    expect(detectFormat([{ role: 'tool', tool_call_id: 'x', content: 'r' }])).toBe('openai');
    expect(
      detectFormat([
        { role: 'user', content: 'a' },
        { role: 'tool', content: 'r' },
      ]),
    ).toBe('openai');
  });

  it('is anthropic when any content array holds a tool_use or tool_result block, before openai', () => {
    const mixed: AnyMessage[] = [
      { role: 'tool', tool_call_id: 'x', content: 'r' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'n', input: {} }] },
    ];
    expect(detectFormat(mixed)).toBe('anthropic');
    expect(
      detectFormat([
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
      ]),
    ).toBe('anthropic');
    // Text-only content arrays are not enough.
    expect(detectFormat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])).toBe('plain');
  });

  it('is langchain for type human/ai/system/tool, class instances and lc_kwargs', () => {
    expect(detectFormat([{ type: 'human', content: 'hi' }])).toBe('langchain');
    expect(detectFormat([{ type: 'system', content: 'be brief' }])).toBe('langchain');
    expect(detectFormat([{ lc_kwargs: { content: 'hi' }, content: 'hi' }])).toBe('langchain');
    class FakeHumanMessage {
      lc_kwargs = { content: 'hi' };
      content = 'hi';
      _getType(): string {
        return 'human';
      }
    }
    expect(detectFormat([new FakeHumanMessage() as unknown as AnyMessage])).toBe('langchain');
    expect(detectFormat([{ content: 'hi', getType: () => 'ai' }])).toBe('langchain');
  });

  it('keeps langchain messages that carry tool_calls/tool_call_id as langchain', () => {
    const lc: AnyMessage[] = [
      {
        type: 'ai',
        content: '',
        tool_calls: [{ id: 'call_1', name: 'bash', args: { command: 'ls' } }],
      },
      { type: 'tool', content: 'ok', tool_call_id: 'call_1' },
    ];
    expect(detectFormat(lc)).toBe('langchain');
  });

  it('normalize with auto reports the detected format, and a forced format is respected', () => {
    expect(normalize(loadFixture('openai-tool-loop'), 'auto').format).toBe('openai');
    expect(normalize(loadFixture('openai-tool-loop'), 'plain').format).toBe('plain');
  });
});

// ───────────────────────────── frame kinds ─────────────────────────────

describe('frame kinds', () => {
  it('openai: system, user, tool_call, tool_result, assistant', () => {
    const fs = frames(loadFixture('openai-tool-loop'));
    expect(frame(fs[0]).kind).toBe('system');
    expect(frame(fs[0]).role).toBe('system');
    expect(frame(fs[1]).kind).toBe('user');
    expect(frame(fs[2]).kind).toBe('tool_call');
    expect(frame(fs[2]).role).toBe('assistant');
    expect(frame(fs[3]).kind).toBe('tool_result');
    expect(frame(fs[3]).role).toBe('tool');
    const plainAssistant = fs.find((f) => f.role === 'assistant' && f.toolCallIds.length === 0);
    expect(frame(plainAssistant).kind).toBe('assistant');
  });

  it('anthropic: a user message of tool_result blocks is a tool_result, text+tool_use is a tool_call', () => {
    const fs = frames(loadFixture('anthropic-tool-loop'));
    expect(frame(fs[0]).kind).toBe('user');
    expect(frame(fs[1]).kind).toBe('tool_call');
    expect(frame(fs[1]).toolNames).toEqual(['bash']);
    expect(frame(fs[2]).kind).toBe('tool_result');
    expect(frame(fs[2]).role).toBe('user');
    const textOnly = fs.find((f) => f.role === 'assistant' && f.toolCallIds.length === 0);
    expect(frame(textOnly).kind).toBe('assistant');
  });

  it('langchain: human→user, ai→assistant, system→system, tool→tool', () => {
    const fs = frames(loadFixture('langchain'));
    expect(frame(fs[0])).toMatchObject({ role: 'system', kind: 'system' });
    expect(frame(fs[1])).toMatchObject({ role: 'user', kind: 'user' });
    expect(frame(fs[2])).toMatchObject({ role: 'assistant', kind: 'tool_call' });
    expect(frame(fs[3])).toMatchObject({ role: 'tool', kind: 'tool_result' });
    // LangChain tool messages carry the tool name.
    expect(frame(fs[3]).toolNames).toEqual(['bash']);
  });

  it('plain: never a tool kind', () => {
    const fs = frames(loadFixture('plain-chat'));
    expect(
      fs.every((f) => f.kind === 'system' || f.kind === 'user' || f.kind === 'assistant'),
    ).toBe(true);
  });

  it('langchain class instances resolve role via _getType and read content/tool_calls/tool_call_id', () => {
    class FakeAIMessage {
      lc_kwargs = {};
      content = 'calling';
      tool_calls = [{ id: 'call_9', name: 'bash', args: { command: 'ls' } }];
      _getType(): string {
        return 'ai';
      }
    }
    class FakeToolMessage {
      lc_kwargs = {};
      content = 'files';
      tool_call_id = 'call_9';
      getType(): string {
        return 'tool';
      }
    }
    const fs = frames([new FakeAIMessage(), new FakeToolMessage()] as unknown as AnyMessage[]);
    expect(frame(fs[0])).toMatchObject({
      role: 'assistant',
      kind: 'tool_call',
      toolCallIds: ['call_9'],
      toolNames: ['bash'],
    });
    expect(frame(fs[0]).text).toBe('calling\n[tool_call bash call_9] {"command":"ls"}');
    expect(frame(fs[1])).toMatchObject({
      role: 'tool',
      kind: 'tool_result',
      toolCallIds: ['call_9'],
    });
  });

  it('maps developer to system and unknown roles to user', () => {
    const fs = frames(
      [
        { role: 'developer', content: 'x' },
        { role: 'weird', content: 'y' },
      ],
      'plain',
    );
    expect(frame(fs[0]).kind).toBe('system');
    expect(frame(fs[1]).kind).toBe('user');
  });

  it('an assistant message with an empty tool_calls array is a plain assistant frame', () => {
    const fs = frames([{ role: 'assistant', content: 'done', tool_calls: [] }], 'openai');
    expect(frame(fs[0]).kind).toBe('assistant');
    expect(frame(fs[0]).text).toBe('done');
  });
});

// ───────────────────────────── text flattening ─────────────────────────────

describe('text flattening', () => {
  it('string content is verbatim; null/undefined content is empty', () => {
    const fs = frames(
      [
        { role: 'user', content: '  keep   my\n\nwhitespace  ' },
        { role: 'assistant', content: null },
        { role: 'assistant' },
      ],
      'plain',
    );
    expect(frame(fs[0]).text).toBe('  keep   my\n\nwhitespace  ');
    expect(frame(fs[0]).chars).toBe('  keep   my\n\nwhitespace  '.length);
    expect(frame(fs[1]).text).toBe('');
    expect(frame(fs[2]).text).toBe('');
  });

  it('joins text blocks with newlines and renders image/other blocks as [type]', () => {
    const fs = frames(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'first' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            { type: 'text', text: 'second' },
            { type: 'image_url', image_url: { url: 'https://x.test/a.png' } },
            { type: 'thinking', thinking: 'hmm' },
            { text: 'untyped text block' },
            'bare string block',
          ],
        },
      ],
      'anthropic',
    );
    expect(frame(fs[0]).text).toBe(
      'first\n[image]\nsecond\n[image_url]\n[thinking]\nuntyped text block\nbare string block',
    );
    expect(frame(fs[0]).kind).toBe('user');
  });

  it('anthropic tool_use and tool_result blocks (string and array content)', () => {
    const fs = frames(
      [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me look.' },
            { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls -la' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt\nb.txt' },
            {
              type: 'tool_result',
              tool_use_id: 'toolu_2',
              content: [
                { type: 'text', text: 'line' },
                { type: 'image', source: {} },
              ],
            },
            { type: 'tool_result', tool_use_id: 'toolu_3' },
          ],
        },
      ],
      'anthropic',
    );
    expect(frame(fs[0]).text).toBe('Let me look.\n[tool_use bash toolu_1] {"command":"ls -la"}');
    expect(frame(fs[0])).toMatchObject({
      kind: 'tool_call',
      toolCallIds: ['toolu_1'],
      toolNames: ['bash'],
    });
    expect(frame(fs[1]).text).toBe(
      '[tool_result toolu_1] a.txt\nb.txt\n[tool_result toolu_2] line\n[image]\n[tool_result toolu_3] ',
    );
    expect(frame(fs[1])).toMatchObject({
      kind: 'tool_result',
      toolCallIds: ['toolu_1', 'toolu_2', 'toolu_3'],
    });
  });

  it('a user message mixing tool_result and text blocks is still a tool_result frame', () => {
    // API validity: a tool_result must stay with its tool_use, so the message joins the unit.
    const fs = frames(
      [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
            { type: 'text', text: 'also, hurry' },
          ],
        },
      ],
      'anthropic',
    );
    expect(frame(fs[0]).kind).toBe('tool_result');
    expect(frame(fs[0]).text).toBe('[tool_result toolu_1] ok\nalso, hurry');
  });

  it('openai tool_calls render the JSON-string arguments verbatim after the content', () => {
    const fs = frames(
      [
        {
          role: 'assistant',
          content: 'Running it.',
          tool_calls: [
            {
              id: 'call_a',
              type: 'function',
              function: { name: 'bash', arguments: '{"command":"pnpm test"}' },
            },
            {
              id: 'call_b',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path": "src/auth.ts"}' },
            },
          ],
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_c', type: 'function', function: { name: 'bash', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_a', content: 'all green' },
      ],
      'openai',
    );
    expect(frame(fs[0]).text).toBe(
      'Running it.\n[tool_call bash call_a] {"command":"pnpm test"}\n[tool_call read_file call_b] {"path": "src/auth.ts"}',
    );
    expect(frame(fs[0])).toMatchObject({
      toolCallIds: ['call_a', 'call_b'],
      toolNames: ['bash', 'read_file'],
    });
    // No content: no leading newline.
    expect(frame(fs[1]).text).toBe('[tool_call bash call_c] {}');
    expect(frame(fs[2]).text).toBe('all green');
    expect(frame(fs[2])).toMatchObject({ toolCallIds: ['call_a'], toolNames: [] });
  });

  it('langchain tool_calls render JSON.stringify(args)', () => {
    const fs = frames(
      [
        {
          type: 'ai',
          content: '',
          tool_calls: [
            { id: 'call_1', name: 'bash', args: { command: 'ls', cwd: '/tmp' }, type: 'tool_call' },
          ],
        },
        { type: 'tool', content: 'out', tool_call_id: 'call_1', name: 'bash' },
      ],
      'langchain',
    );
    expect(frame(fs[0]).text).toBe('[tool_call bash call_1] {"command":"ls","cwd":"/tmp"}');
    expect(frame(fs[1])).toMatchObject({
      text: 'out',
      toolCallIds: ['call_1'],
      toolNames: ['bash'],
    });
  });

  it('openai content arrays flatten text and image_url blocks', () => {
    const fs = frames(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: 'data:...' } },
          ],
        },
      ],
      'openai',
    );
    expect(frame(fs[0]).text).toBe('what is this?\n[image_url]');
  });
});

// ───────────────────────────── paths / hasCode / hash / tokens / pins ─────────────────────────────

describe('paths', () => {
  it('extracts path-like tokens, known file names and URLs, unique and ≥ 4 chars', () => {
    const text =
      'see src/auth.ts and ./lib plus https://example.com/docs?q=1 — also package.json, a/b is short, foo.bar() is not a file, src/auth.ts again';
    const [f] = frames([{ role: 'user', content: text }], 'plain');
    const paths = frame(f).paths;
    expect(paths).toContain('src/auth.ts');
    expect(paths).toContain('./lib');
    expect(paths).toContain('https://example.com/docs?q=1');
    expect(paths).toContain('package.json');
    expect(paths).toContain('auth.ts');
    expect(paths).not.toContain('a/b');
    expect(paths).not.toContain('foo.bar');
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('is empty for prose without paths', () => {
    const [f] = frames(
      [{ role: 'user', content: 'Thanks, that was great. How is your day?' }],
      'plain',
    );
    expect(frame(f).paths).toEqual([]);
  });
});

describe('hasCode', () => {
  const has = (content: string): boolean =>
    frame(frames([{ role: 'user', content }], 'plain')[0]).hasCode;

  it('is true for fenced blocks and unified diff headers', () => {
    expect(has('```ts\nconst a = 1;\n```')).toBe(true);
    expect(has('--- a/x.ts\n+++ b/x.ts')).toBe(true);
    expect(has('@@ -1,2 +1,2 @@\n x')).toBe(true);
  });

  it('is true for three or more +/- changed lines and false otherwise', () => {
    expect(has('+a\n-b\n+c')).toBe(true);
    expect(has('+a\n-b')).toBe(false);
    expect(has('++a\n--b\n++c')).toBe(false);
    expect(has('plain prose with a - dash - inside - it')).toBe(false);
    expect(has('')).toBe(false);
  });

  it('recognizes a diff carried inside a JSON-string tool argument (escaped newlines)', () => {
    const escaped = String.raw`{"path":"x.ts","patch":"--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n"}`;
    expect(escaped).not.toContain('\n');
    expect(has(escaped)).toBe(true);
    expect(has(String.raw`{"lines":"\n+a\n-b\n+c"}`)).toBe(true);
    expect(has(String.raw`{"lines":"\n+a\n-b"}`)).toBe(false);
    // The apply_patch tool call in the fixtures is exactly this case.
    const [call] = frames(
      [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_p',
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments: JSON.stringify({ patch: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n' }),
              },
            },
          ],
        },
      ],
      'openai',
    );
    expect(frame(call).hasCode).toBe(true);
  });
});

describe('hash, tokens, chars, index, pins', () => {
  it('hash is sha1 hex of role + NUL + text', () => {
    const fs = frames(
      [
        { role: 'user', content: 'same' },
        { role: 'assistant', content: 'same' },
        { role: 'user', content: 'same' },
      ],
      'plain',
    );
    expect(frame(fs[0]).hash).toMatch(/^[0-9a-f]{40}$/);
    expect(frame(fs[0]).hash).toBe(frame(fs[2]).hash);
    expect(frame(fs[0]).hash).not.toBe(frame(fs[1]).hash);
  });

  it('tokens count the original message, chars count the flattened text, index is the position', () => {
    const messages: AnyMessage[] = [
      { role: 'system', content: 'sys' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'bash', arguments: '{"command":"ls"}' },
          },
        ],
      },
    ];
    const fs = frames(messages, 'openai');
    fs.forEach((f, i) => {
      expect(f.index).toBe(i);
      expect(f.tokens).toBe(messageTokens(must(messages[i])));
      expect(f.chars).toBe(f.text.length);
    });
    expect(frame(fs[1]).tokens).toBeGreaterThan(frame(fs[1]).chars / 2.5);
  });

  it('pinned honors message.pin === true and the pin callback with the original object', () => {
    const messages: AnyMessage[] = [
      { role: 'user', content: 'a', pin: true },
      { role: 'user', content: 'b', pin: 'yes' },
      { role: 'user', content: 'c' },
    ];
    const seen: Array<[number, AnyMessage]> = [];
    const { frames: fs } = normalize(messages, 'plain', (i, m) => {
      seen.push([i, m]);
      return i === 2;
    });
    expect(fs.map((f) => f.pinned)).toEqual([true, false, true]);
    // `pin: true` short-circuits; the callback runs for the other two with the original objects.
    expect(seen.map(([i]) => i)).toEqual([1, 2]);
    expect(seen[0]?.[1]).toBe(messages[1]);
    expect(seen[1]?.[1]).toBe(messages[2]);
  });

  it('never mutates the input messages', () => {
    const messages = loadFixture('anthropic-tool-loop');
    const before = JSON.stringify(messages);
    normalize(messages, 'auto', () => true);
    expect(JSON.stringify(messages)).toBe(before);
  });
});

// ───────────────────────────── groupUnits ─────────────────────────────

describe('groupUnits', () => {
  it('two tool calls in one assistant message absorb both results into one unit', () => {
    const fs = frames(
      [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_a',
              type: 'function',
              function: { name: 'bash', arguments: '{"command":"cat a"}' },
            },
            {
              id: 'call_b',
              type: 'function',
              function: { name: 'bash', arguments: '{"command":"cat b"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_a', content: 'A' },
        { role: 'tool', tool_call_id: 'call_b', content: 'B' },
        { role: 'assistant', content: 'both read' },
      ],
      'openai',
    );
    const units = groupUnits(fs);
    expect(units.map((u) => u.id)).toEqual(['u0', 'u1', 'u2']);
    expect(units.map((u) => u.indices)).toEqual([[0], [1, 2, 3], [4]]);
    const tool = must(units[1]);
    expect(tool.isTool).toBe(true);
    expect(tool.frames.map((f) => f.index)).toEqual([1, 2, 3]);
    expect(tool.tokens).toBe(frame(fs[1]).tokens + frame(fs[2]).tokens + frame(fs[3]).tokens);
    expect(tool.text).toBe([frame(fs[1]).text, 'A', 'B'].join('\n'));
    expect(units[0]?.isTool).toBe(false);
    expect(units[2]?.isTool).toBe(false);
  });

  it('an orphan tool_result becomes its own unit, and results may interleave with other results', () => {
    const fs = frames(
      [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'bash', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_zzz', content: 'orphan' },
        { role: 'tool', tool_call_id: 'call_a', content: 'mine' },
        { role: 'user', content: 'next' },
      ],
      'openai',
    );
    const units = groupUnits(fs);
    expect(units.map((u) => u.indices)).toEqual([[0, 2], [1], [3]]);
    expect(units[1]).toMatchObject({ id: 'u1', isTool: true, text: 'orphan' });
    expect(units[1]?.frames[0]?.kind).toBe('tool_result');
  });

  it('a frame that is neither a call nor a result stops absorption', () => {
    const fs = frames(
      [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'bash', arguments: '{}' } },
          ],
        },
        { role: 'user', content: 'interrupt' },
        { role: 'tool', tool_call_id: 'call_a', content: 'late' },
      ],
      'openai',
    );
    const units = groupUnits(fs);
    expect(units.map((u) => u.indices)).toEqual([[0], [1], [2]]);
    expect(units[2]?.isTool).toBe(true);
  });

  it('a later tool_call is not absorbed by an earlier one even when results follow', () => {
    const fs = frames(
      [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'bash', arguments: '{}' } },
          ],
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_b', type: 'function', function: { name: 'bash', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_b', content: 'B' },
      ],
      'openai',
    );
    expect(groupUnits(fs).map((u) => u.indices)).toEqual([[0], [1, 2]]);
  });

  it('anthropic: text+tool_use message and its tool_result user message form one unit', () => {
    const fs = frames(loadFixture('anthropic-tool-loop'));
    const units = groupUnits(fs);
    expect(units[0]?.indices).toEqual([0]);
    expect(units[1]?.indices).toEqual([1, 2]);
    // The parallel read: two tool_use blocks answered by one user message with two tool_result blocks.
    expect(units[2]?.indices).toEqual([3, 4]);
    expect(units[2]?.frames[0]?.toolCallIds).toHaveLength(2);
  });

  it.each(FIXTURES)(
    '%s: every frame lands in exactly one unit, in order, with no orphans',
    (name) => {
      const fs = frames(loadFixture(name));
      const units = groupUnits(fs);
      const covered = units.flatMap((u) => u.indices).sort((a, b) => a - b);
      expect(covered).toEqual(fs.map((_, i) => i));
      units.forEach((u, i) => {
        expect(u.id).toBe(`u${i}`);
        expect([...u.indices]).toEqual([...u.indices].sort((a, b) => a - b));
        expect(u.frames[0]?.kind).not.toBe('tool_result');
        expect(u.tokens).toBe(u.frames.reduce((s, f) => s + f.tokens, 0));
        expect(u.isTool).toBe(
          u.frames.some((f) => f.kind === 'tool_call' || f.kind === 'tool_result'),
        );
      });
      const results = fs.filter((f) => f.kind === 'tool_result').length;
      expect(units).toHaveLength(fs.length - results);
    },
  );

  it('is empty for no frames', () => {
    expect(groupUnits([])).toEqual([]);
  });
});

// ───────────────────────────── defaultGoal ─────────────────────────────

describe('defaultGoal', () => {
  it('is the text of the last user frame, ignoring tool results', () => {
    const fs = frames(
      [
        { role: 'user', content: 'first ask' },
        { role: 'user', content: 'real goal' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'bash', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_a', content: 'not the goal' },
      ],
      'openai',
    );
    expect(defaultGoal(fs)).toBe('real goal');
  });

  it('skips anthropic tool_result user messages', () => {
    const fs = frames(
      [
        { role: 'user', content: 'goal here' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'output' }] },
      ],
      'anthropic',
    );
    expect(defaultGoal(fs)).toBe('goal here');
  });

  it('caps at 500 characters and is empty without a user frame', () => {
    const long = 'x'.repeat(1200);
    expect(defaultGoal(frames([{ role: 'user', content: long }], 'plain'))).toBe('x'.repeat(500));
    expect(
      defaultGoal(
        frames(
          [
            { role: 'system', content: 's' },
            { role: 'assistant', content: 'a' },
          ],
          'plain',
        ),
      ),
    ).toBe('');
    expect(defaultGoal([])).toBe('');
  });

  it.each(FIXTURES)('%s: the default goal mentions src/auth.ts', (name) => {
    expect(defaultGoal(frames(loadFixture(name)))).toContain('src/auth.ts');
  });
});

// ───────────────────────────── fixtures tell the story ─────────────────────────────

describe.each(FIXTURES)('fixture %s', (name) => {
  const messages = loadFixture(name);
  const fs = frames(messages);

  it('has at least 30 messages', () => {
    expect(messages.length).toBeGreaterThanOrEqual(30);
  });

  it('contains one assistant rm -rf proposal', () => {
    const hits = fs.filter((f) => f.text.includes('rm -rf ./src'));
    expect(hits).toHaveLength(1);
    expect(hits[0]?.role).toBe('assistant');
  });

  it('shows the same failing test output twice, verbatim', () => {
    const hits = fs.filter((f) => f.text.includes(FAIL_MARKER));
    expect(hits).toHaveLength(2);
    const [a, b] = hits;
    if (name === 'anthropic-tool-loop') {
      // Anthropic results carry a `[tool_result <id>]` prefix; the output after it is identical.
      const body = (f: Frame | undefined): string =>
        frame(f).text.replace(/^\[tool_result \S+\] /, '');
      expect(body(a)).toBe(body(b));
    } else {
      expect(frame(a).text).toBe(frame(b).text);
      expect(frame(a).hash).toBe(frame(b).hash);
    }
  });

  it('carries the content of src/auth.ts in a unit that names the path', () => {
    const units = groupUnits(fs);
    const unit = units.find((u) => u.text.includes(AUTH_TS_MARKER));
    expect(unit).toBeDefined();
    expect(unit?.frames.some((f) => f.paths.includes('src/auth.ts'))).toBe(true);
    if (name !== 'plain-chat') {
      expect(unit?.isTool).toBe(true);
      expect(
        unit?.frames.some((f) => f.kind === 'tool_result' && f.text.includes(AUTH_TS_MARKER)),
      ).toBe(true);
    }
  });

  it('has an off-topic pleasantry and a code-bearing patch', () => {
    expect(fs.some((f) => f.role === 'user' && f.text.includes('lifesaver'))).toBe(true);
    expect(fs.some((f) => f.hasCode && f.text.includes('+++ b/src/auth.ts'))).toBe(true);
  });

  it('later messages supersede earlier ones (boundary test added, then reverted)', () => {
    const added = fs.findIndex(
      (f) => f.role === 'user' && f.text.includes('expires exactly at `now`'),
    );
    const reverted = fs.findIndex(
      (f) => f.role === 'user' && f.text.includes('skip the boundary test'),
    );
    expect(added).toBeGreaterThan(-1);
    expect(reverted).toBeGreaterThan(added);
  });
});

// ───────────────────────────── legacy OpenAI function calling ─────────────────────────────

describe('legacy OpenAI function calling', () => {
  const messages: AnyMessage[] = [
    { role: 'user', content: 'list files' },
    {
      role: 'assistant',
      content: null,
      function_call: { name: 'bash', arguments: '{"command":"ls"}' },
    },
    { role: 'function', name: 'bash', content: 'a.txt\nb.txt' },
    { role: 'assistant', content: 'two files' },
    { role: 'user', content: 'ok' },
  ];

  it('is detected as openai and pairs the function_call with its role:function result as one unit', () => {
    expect(detectFormat(messages)).toBe('openai');
    expect(detectFormat([{ role: 'function', name: 'x', content: 'y' }])).toBe('openai');
    const units = groupUnits(normalize(messages, 'auto').frames);
    expect(units.map((u) => u.indices)).toEqual([[0], [1, 2], [3], [4]]);
    const call = units[1] as Unit;
    expect(call.isTool).toBe(true);
    expect(call.frames.map((f) => f.kind)).toEqual(['tool_call', 'tool_result']);
    expect(call.frames[0]?.toolNames).toEqual(['bash']);
    expect(call.frames[0]?.text).toBe('[tool_call bash function:bash] {"command":"ls"}');
    expect(call.frames[1]?.toolCallIds).toEqual(['function:bash']);
  });

  it('only pairs a result with the call of the same function, and leaves a modern tool message with an id alone', () => {
    const mismatched = groupUnits(
      normalize(
        [
          { role: 'assistant', content: null, function_call: { name: 'bash', arguments: '{}' } },
          { role: 'function', name: 'python', content: 'nope' },
        ],
        'auto',
      ).frames,
    );
    expect(mismatched.map((u) => u.indices)).toEqual([[0], [1]]);
    const modern = normalize(
      [{ role: 'tool', tool_call_id: 'c1', name: 'bash', content: 'r' }],
      'auto',
    ).frames;
    expect(modern[0]?.toolCallIds).toEqual(['c1']);
  });
});

// ───────────────────────────── pendingUnit / actionIndices ─────────────────────────────

describe('pendingUnit and actionIndices', () => {
  const unitsOfList = (messages: AnyMessage[]): Unit[] =>
    groupUnits(normalize(messages, 'auto').frames);

  it('is the newest non-system unit when the agent authored it, else undefined', () => {
    const said = unitsOfList([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'doing it' },
    ]);
    expect(pendingUnit(said)?.id).toBe('u1');
    const asked = unitsOfList([
      { role: 'assistant', content: 'doing it' },
      { role: 'user', content: 'no, wait' },
    ]);
    expect(pendingUnit(asked)).toBeUndefined();
    const noted = unitsOfList([
      { role: 'assistant', content: 'doing it' },
      { role: 'system', content: 'notice' },
    ]);
    expect(pendingUnit(noted)?.id).toBe('u0'); // a trailing system message does not resolve the action
    const orphan = unitsOfList([
      { role: 'user', content: 'go' },
      { role: 'tool', tool_call_id: 'x', content: 'late' },
    ]);
    expect(pendingUnit(orphan)).toBeUndefined();
    expect(pendingUnit([])).toBeUndefined();
  });

  it('a tool call with its results is pending, and actionIndices names only the agent-authored frames', () => {
    const openai = unitsOfList([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'running',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'out' },
    ]);
    const pending = pendingUnit(openai) as Unit;
    expect(pending.indices).toEqual([1, 2]);
    expect(actionIndices(pending)).toEqual([1]);

    const anthropic = unitsOfList([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }] },
    ]);
    const anthropicPending = pendingUnit(anthropic) as Unit;
    expect(anthropicPending.indices).toEqual([1, 2]);
    expect(actionIndices(anthropicPending)).toEqual([1]); // the tool_result rides in a user message
  });
});
