/**
 * Token estimation. The default heuristic (2.5 chars/token) is deliberately conservative for
 * JSON-dense state (measured ≈2.2 on Jev, see docs/JEV-API.md); callers can inject a real counter.
 */
import type { AnyMessage } from './types.js';

export const CHARS_PER_TOKEN = 2.5;

/** `ceil(chars / 2.5)`, 0 for the empty string. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Tokens of `JSON.stringify(message)` — the bytes that actually travel to the model. */
export function messageTokens(
  message: AnyMessage,
  countTokens: (text: string) => number = estimateTokens,
): number {
  // JSON.stringify returns undefined only for non-serializable roots (a toJSON returning undefined);
  // count that as empty rather than crashing the pipeline on an exotic message object.
  const json: string | undefined = JSON.stringify(message);
  return countTokens(json ?? '');
}

/** Sum of `messageTokens` over the array. */
export function messagesTokens(
  messages: AnyMessage[],
  countTokens?: (text: string) => number,
): number {
  let total = 0;
  for (const message of messages) total += messageTokens(message, countTokens);
  return total;
}
