// Upstream: OpenAI Codex CLI, local compaction (`/compact` and pre-turn auto-compact).
// Source:   github.com/openai/codex @ 78245b47af2a7aafcabe025828ceecca69db4df1 (2026-09-19),
//   codex-rs/prompts/templates/compact/prompt.md (SUMMARIZATION_PROMPT, verbatim below, loaded with
//   include_str! so it keeps its trailing newline), codex-rs/prompts/templates/compact/
//   summary_prefix.md (SUMMARY_PREFIX, verbatim below), codex-rs/core/src/compact.rs:
//   run_compact_task_inner_impl, collect_annotated_user_messages, build_compacted_history_with_limit,
//   COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000; codex-rs/utils/string/src/truncate.rs
//   approx_token_count (bytes / 4, rounded up) and truncate_middle_with_token_budget;
//   codex-rs/models-manager/models.json + protocol/src/openai_models.rs
//   mark_default_by_picker_visibility (the default model is the first picker-visible catalog entry:
//   gpt-6-astra, priority 1). License: Apache-2.0.
// Algorithm (ported): send the full history with the prompt appended as the final user turn; take
//   the assistant's text as the summary; rebuild history = initial context + the most recent real
//   user messages that fit in 20k approx tokens (the one that crosses the limit is middle-truncated
//   to the remaining budget, head and tail kept, "…N tokens truncated…" marker) + one user message
//   `${SUMMARY_PREFIX}\n${summary}`. Tool calls and tool outputs are not kept.
// Fidelity: APPROXIMATE.
//   - Model: gpt-6-astra, Codex's catalog default, through OpenRouter (openai/gpt-6-astra,
//     $10 / $50 per million there) — override with BENCH_CODEX_MODEL. (An earlier revision of this
//     file wrongly claimed the model was absent from OpenRouter and used gpt-5.6-terra.)
//   - Transport: OpenRouter chat completions instead of the Responses API; Codex's own base
//     instructions, user_instructions and environment_context items are not available, so the
//     transcript's system message plays "initial context" and the summarizer sees a bare history.
//   - Reasoning effort and the model's Codex-side instructions are not applied.
// What survives: the system message, recent user messages verbatim (<= 20k tokens), the summary.
import { contentText, openaiToolStubs, openrouter, toOpenAIShape } from './_llm.mjs';

export const SUMMARIZATION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.\n`;

export const SUMMARY_PREFIX =
  'Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:';

const MODEL = process.env.BENCH_CODEX_MODEL ?? 'openai/gpt-6-astra';
const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;
const APPROX_BYTES_PER_TOKEN = 4;

const approxTokenCount = (text) =>
  Math.floor((Buffer.byteLength(text) + APPROX_BYTES_PER_TOKEN - 1) / APPROX_BYTES_PER_TOKEN);

const approxTokensFromByteCount = (bytes) =>
  Math.floor((bytes + APPROX_BYTES_PER_TOKEN - 1) / APPROX_BYTES_PER_TOKEN);

/** Slice `text` to at most `bytes` UTF-8 bytes from the start, on a character boundary. */
function headBytes(text, bytes) {
  let out = '';
  for (const ch of text) {
    if (Buffer.byteLength(out + ch) > bytes) break;
    out += ch;
  }
  return out;
}
/** Slice `text` to at most `bytes` UTF-8 bytes from the end, on a character boundary. */
function tailBytes(text, bytes) {
  const chars = [...text];
  let out = '';
  for (let i = chars.length - 1; i >= 0; i--) {
    if (Buffer.byteLength(chars[i] + out) > bytes) break;
    out = chars[i] + out;
  }
  return out;
}

/**
 * truncate_middle_with_token_budget: keep the head and tail within `tokens` approx tokens (bytes/4),
 * splitting the byte budget floor(b/2) / b - floor(b/2), with Codex's "…N tokens truncated…" marker.
 */
function truncateText(text, tokens) {
  const budget = tokens * APPROX_BYTES_PER_TOKEN;
  const total = Buffer.byteLength(text);
  if (tokens > 0 && total <= budget) return text;
  if (budget === 0) return `…${approxTokensFromByteCount(total)} tokens truncated…`;
  const left = Math.floor(budget / 2);
  const right = budget - left;
  const head = headBytes(text, left);
  const tail = tailBytes(text, right);
  const removed = approxTokensFromByteCount(total - budget);
  return `${head}…${removed} tokens truncated…${tail}`;
}

const isSummaryMessage = (text) => text.startsWith(`${SUMMARY_PREFIX}\n`);

/** build_compacted_history_with_limit: newest user messages first until 20k tokens, then reverse. */
export function buildCompactedHistory(initialContext, userMessages, summaryText) {
  const selected = [];
  let remaining = COMPACT_USER_MESSAGE_MAX_TOKENS;
  for (let i = userMessages.length - 1; i >= 0; i--) {
    if (remaining === 0) break;
    const m = userMessages[i];
    const text = contentText(m.content);
    const tokens = approxTokenCount(text);
    if (tokens <= remaining) {
      selected.push(m);
      remaining -= tokens;
    } else {
      selected.push({ role: 'user', content: truncateText(text, remaining) });
      break;
    }
  }
  selected.reverse();
  return [
    ...initialContext,
    ...selected,
    { role: 'user', content: `${SUMMARY_PREFIX}\n${summaryText || '(no summary available)'}` },
  ];
}

export default {
  name: `codex-cli:${MODEL}`,
  async run(input) {
    const messages = toOpenAIShape(input);
    const r = await openrouter(
      MODEL,
      [...messages, { role: 'user', content: SUMMARIZATION_PROMPT }],
      { maxTokens: 8192, tools: openaiToolStubs(messages) },
    );
    const summary = r.text.trim();
    const initialContext = messages.filter((m) => m.role === 'system');
    const userMessages = messages.filter(
      (m) => m.role === 'user' && !isSummaryMessage(contentText(m.content)),
    );
    return {
      output: buildCompactedHistory(initialContext, userMessages, summary),
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      latencyMs: r.latencyMs,
      costUsd: r.costUsd,
    };
  },
};
