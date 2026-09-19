// Upstream: Anthropic's server-side compaction (the official Claude API mechanism; Claude Code's own
//   /compact prompt is not published and its binary is not reverse-engineered here).
// Source:   https://platform.claude.com/docs/en/build-with-claude/compaction (fetched 2026-09-18,
//   re-fetched 2026-09-19: both betas, the default prompt text and usage.iterations re-verified).
//   Threshold compaction: beta `compact-2026-01-12`, `context_management.edits[].type =
//   "compact_20260112"`, trigger `{type: "input_tokens", value >= 50000}`, `pause_after_compaction`,
//   optional `instructions` that REPLACE the default prompt. Billing is the sum of
//   `usage.iterations`. On-demand compaction: beta `compact-2026-09-04`, top-level
//   `compaction: {type: "summarize"}` — summarizes every message once, returns only the block.
// License:  documentation, no code copied. Model: claude-sonnet-5 (list price $2/$10 per M).
//
// Fidelity by path (BENCH_CLAUDE_COMPACTION selects; default 'auto'):
//   'threshold'  EXACT: the real beta API with the default prompt, trigger 50k, pause after
//                compaction. Needs >= 50k real input tokens, so 'auto' takes it only when the
//                transcript is >= 55k estimated tokens (fixtures/long-noisy-openai-55k.json).
//   'on-demand'  EXACT: the real `compaction: {type: "summarize"}` request, any size.
//   'client'     APPROXIMATE: the published default prompt sent client-side as an ordinary Messages
//                call (the transcript, then the prompt as a user turn, same system + tools). The
//                API's actual per-model default prompt may differ from the published example.
// What survives: nothing verbatim. The product keeps the returned assistant message with its
// `compaction` block and sends it in place of the summarized history; the benchmark scores the
// block's text (a string — the whole history is replaced by text). Transcript conversion
// (OpenAI tool_calls -> tool_use/tool_result, tool stubs) is in _llm.mjs.
import { messagesTokens } from 'jev-compactor';
import { anthropic, between, CLAUDE_MODEL, toAnthropic, toOpenAIShape } from './_llm.mjs';

/** The default prompt Anthropic publishes as the one "some models use". Verbatim. */
export const PUBLISHED_DEFAULT_PROMPT =
  'You have written a partial transcript for the initial task above. Please write a summary of the transcript. The purpose of this summary is to provide continuity so you can continue to make progress towards solving the task in a future context, where the raw history above may not be accessible and will be replaced with this summary. Write down anything that would be helpful, including the state, next steps, learnings etc. You must wrap your summary in a <summary></summary> block.';

const MODE = process.env.BENCH_CLAUDE_COMPACTION ?? 'auto';
const REAL_API_MIN_ESTIMATED_TOKENS = 55_000;
const TRIGGER_MIN = 50_000;
const MAX_TOKENS = Number(process.env.BENCH_CLAUDE_MAX_TOKENS ?? 8192);

async function clientDefaultPrompt(messages) {
  const { system, messages: conv, tools } = toAnthropic(messages);
  const r = await anthropic(CLAUDE_MODEL, {
    system,
    tools,
    messages: [...conv, { role: 'user', content: PUBLISHED_DEFAULT_PROMPT }],
    maxTokens: MAX_TOKENS,
  });
  return { ...r, summary: between(r.text, 'summary') };
}

async function thresholdCompaction(messages) {
  const { system, messages: conv, tools } = toAnthropic(messages);
  const r = await anthropic(CLAUDE_MODEL, {
    system,
    tools,
    messages: conv,
    maxTokens: MAX_TOKENS,
    betas: ['compact-2026-01-12'],
    contextManagement: {
      edits: [
        {
          type: 'compact_20260112',
          trigger: { type: 'input_tokens', value: TRIGGER_MIN },
          pause_after_compaction: true,
        },
      ],
    },
  });
  if (!r.compaction)
    throw new Error(
      `threshold compaction did not fire (stop_reason ${r.stopReason}, input ${r.inputTokens} tokens < ${TRIGGER_MIN}?)`,
    );
  return { ...r, summary: r.compaction.content };
}

async function onDemandCompaction(messages) {
  const { system, messages: conv, tools } = toAnthropic(messages);
  const r = await anthropic(CLAUDE_MODEL, {
    system,
    tools,
    messages: conv,
    maxTokens: MAX_TOKENS,
    betas: ['compact-2026-09-04'],
    compaction: { type: 'summarize' },
  });
  if (!r.compaction)
    throw new Error(`on-demand compaction returned no block (stop_reason ${r.stopReason})`);
  return { ...r, summary: r.compaction.content };
}

export default {
  name: `claude-api-compaction:${MODE}`,
  async run(input) {
    const messages = toOpenAIShape(input);
    let path = MODE;
    if (MODE === 'auto')
      path = messagesTokens(messages) >= REAL_API_MIN_ESTIMATED_TOKENS ? 'threshold' : 'client';
    const r =
      path === 'threshold'
        ? await thresholdCompaction(messages)
        : path === 'on-demand'
          ? await onDemandCompaction(messages)
          : await clientDefaultPrompt(messages);
    console.error(
      `  claude-api-compaction: path=${path} model=${CLAUDE_MODEL} in=${r.inputTokens} out=${r.outputTokens} stop=${r.stopReason}`,
    );
    return {
      output: r.summary,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      latencyMs: r.latencyMs,
      costUsd: r.costUsd,
    };
  },
};
