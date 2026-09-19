import { describe, expect, it } from 'vitest';
import { CHARS_PER_TOKEN, estimateTokens, messagesTokens, messageTokens } from '../src/tokens.js';
import type { AnyMessage } from '../src/types.js';

describe('estimateTokens', () => {
  it('uses 2.5 chars per token', () => {
    expect(CHARS_PER_TOKEN).toBe(2.5);
  });

  it('returns 0 for the empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('rounds up', () => {
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('abcdef')).toBe(3);
    expect(estimateTokens('x'.repeat(250))).toBe(100);
    expect(estimateTokens('x'.repeat(251))).toBe(101);
  });
});

describe('messageTokens', () => {
  const message: AnyMessage = { role: 'user', content: 'hello world' };

  it('counts the JSON serialization of the message, not just its content', () => {
    const json = JSON.stringify(message);
    expect(messageTokens(message)).toBe(estimateTokens(json));
    expect(messageTokens(message)).toBeGreaterThan(estimateTokens('hello world'));
  });

  it('honors a custom counter', () => {
    const json = JSON.stringify(message);
    expect(messageTokens(message, (t) => t.length)).toBe(json.length);
    expect(messageTokens(message, () => 7)).toBe(7);
  });

  it('serializes nested tool call structures', () => {
    const m: AnyMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'bash', arguments: '{"command":"ls"}' },
        },
      ],
    };
    expect(messageTokens(m)).toBe(estimateTokens(JSON.stringify(m)));
  });
});

describe('messagesTokens', () => {
  it('is 0 for an empty array', () => {
    expect(messagesTokens([])).toBe(0);
  });

  it('sums messageTokens over the array', () => {
    const messages: AnyMessage[] = [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello there, how can I help?' },
    ];
    const expected = messages.reduce((sum, m) => sum + messageTokens(m), 0);
    expect(messagesTokens(messages)).toBe(expected);
  });

  it('passes the custom counter through', () => {
    const messages: AnyMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ];
    expect(messagesTokens(messages, () => 5)).toBe(10);
  });
});
