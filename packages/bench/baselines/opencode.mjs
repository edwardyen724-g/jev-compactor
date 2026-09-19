// Upstream: OpenCode (anomalyco/opencode, formerly sst/opencode) session compaction (`/compact` and
//   overflow auto-compaction).
// Source:   github.com/anomalyco/opencode, dev branch, package version 1.18.31 (fetched 2026-09-18):
//   packages/opencode/src/session/compaction.ts (serialize, select, prune, processCompaction),
//   packages/core/src/session/compaction.ts (buildPrompt, SUMMARY_TEMPLATE, verbatim below),
//   packages/opencode/src/agent/prompt/compaction.txt (the compaction agent's system prompt,
//   verbatim below), packages/opencode/src/session/overflow.ts (usable), packages/core/src/util/
//   token.ts (estimate = round(chars / 4)). License: MIT.
// Algorithm (ported): messages are serialized to text ([User]: / [Assistant]: / [Assistant tool
//   call]: name(json) / [Tool result]: output truncated to 2,000 chars). `select` keeps a verbatim
//   tail of whole user-turns fitting preserve_recent_tokens = min(15000, max(2000, usable*0.25))
//   (15,000 for a 1M-context model); when the whole conversation fits that budget, keep.start is 0
//   and the WHOLE conversation is summarized with no tail. The compaction agent (system prompt
//   below) receives buildPrompt(conversation) as the user message and its reply becomes an
//   assistant message flagged `summary`; in auto mode a synthetic user message "Continue if you have
//   next steps, or stop and ask for clarification if you are unsure how to proceed." follows.
//   A separate prune step clears tool outputs older than the last 40,000 tokens of tool output
//   (PRUNE_PROTECT) when at least 20,000 tokens (PRUNE_MINIMUM) would be freed — but only when
//   `compaction.prune` is set in the user's config (core/src/config schema: "default: false"), so
//   it is OFF here unless BENCH_OPENCODE_PRUNE=1.
//   The request is assembled by session/llm/request.ts: system = [agent.prompt] (the compaction
//   agent's prompt; `system: []` and no user.system), one user message, no tools, and
//   maxOutputTokens = ProviderTransform.maxOutputTokens(model) = min(model.limit.output, 32_000)
//   (provider/transform.ts OUTPUT_TOKEN_MAX) — 32,000 for claude-sonnet-5. (SUMMARY_OUTPUT_TOKENS =
//   4096 belongs to the newer packages/core runtime, not the CLI path ported here.)
// Fidelity: APPROXIMATE.
//   - Model: the user's; here claude-sonnet-5 through the Anthropic API (OpenCode would call it
//     through the AI SDK with the same system/user split).
//   - The transcript's system message stands in for the agent's system prompt (out of band in
//     OpenCode) and is carried through unchanged. The OpenAI tool message is rendered under its
//     assistant tool call, as OpenCode stores tool parts inside the assistant message.
//   - Plugin hooks (experimental.session.compacting) are not modelled.
// What survives: the system message, the summary, the kept tail (none for this fixture), the
//   continue message.
import { anthropic, CLAUDE_MODEL, contentText, parseArgs, toOpenAIShape } from './_llm.mjs';

export const PRUNE_MINIMUM = 20_000;
export const PRUNE_PROTECT = 40_000;
const TOOL_OUTPUT_MAX_CHARS = 2_000;
const MIN_PRESERVE_RECENT_TOKENS = 2_000;
const MAX_PRESERVE_RECENT_TOKENS = 15_000;
const OUTPUT_TOKEN_MAX = 32_000;
const PRUNE_ENABLED = process.env.BENCH_OPENCODE_PRUNE === '1';
const COMPACTION_BUFFER = 20_000;
/** claude-sonnet-5 limits as OpenCode's models.dev catalog reports them (context 1M, output 64k). */
const MODEL_LIMIT = { context: 1_000_000, output: 64_000 };

const estimate = (input) => Math.max(0, Math.round(input.length / 4));

/** packages/opencode/src/agent/prompt/compaction.txt — the compaction agent's system prompt. */
export const PROMPT_COMPACTION = `You are a context summarization agent. You are given a conversation between a user and an agent. Your goal is to produce a structured summary matching the format specified so another coding agent can continue the work.

Always follow the exact output structure requested by the user prompt. Keep every section, preserve exact file paths and identifiers when known, and prefer terse bullets over paragraphs.

Do not continue the conversation. Do not respond to any questions in the conversation. Only output the structured summary in the exact format requested by the user prompt. Respond in the same language as the conversation.
`;

const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

const SUMMARY_UPDATE_INSTRUCTIONS = `The <prior-summary> summarizes everything that happened before the <conversation>. Construct a new summary that combines both. The <prior-summary> is discarded after this: anything you do not carry into the new summary is lost.

When combining:
- Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary> even when the <conversation> does not mention them. Drop only what is finished and no longer needed.
- The <conversation> is more recent than the <prior-summary>. Where they conflict, the conversation wins: state the corrected fact and drop the old claim.
- Add new progress, decisions, constraints, and context from the conversation.
- Move completed work from "Active" to "Completed".
- If a blocker has been resolved, update the summary to reflect that while keeping any details still needed to continue the work.
- Update "Objective" and "Next Move" to reflect the current work state.`;

export function buildPrompt({ previousSummary, context }) {
  const conversation = `Here is the conversation so far:\n\n<conversation>\n${context.join('\n\n')}\n</conversation>`;
  if (!previousSummary)
    return [
      conversation,
      'Create a new anchored summary from the conversation history in the <conversation> tags above so another coding agent can continue the work.',
      SUMMARY_TEMPLATE,
    ].join('\n\n');
  return [
    conversation,
    `Here is the summary of the conversation before the <conversation> above:\n\n<prior-summary>\n${previousSummary}\n</prior-summary>`,
    SUMMARY_UPDATE_INSTRUCTIONS,
    SUMMARY_TEMPLATE,
  ].join('\n\n');
}

const truncate = (value) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS
    ? value
    : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`;

/**
 * Group the OpenAI transcript into OpenCode-style messages: a user message, or an assistant
 * message whose tool parts carry their results (looked up by tool_call_id).
 */
function toOpenCodeMessages(messages) {
  const results = new Map();
  for (const [i, m] of messages.entries()) if (m.role === 'tool') results.set(m.tool_call_id, i);
  const out = [];
  for (const [i, m] of messages.entries()) {
    if (m.role === 'user') out.push({ role: 'user', text: contentText(m.content), indices: [i] });
    else if (m.role === 'assistant') {
      const tools = (m.tool_calls ?? []).map((tc) => ({
        tool: tc.function?.name ?? 'tool',
        input: parseArgs(tc.function?.arguments),
        result: results.has(tc.id) ? messages[results.get(tc.id)] : undefined,
        compacted: false,
      }));
      out.push({
        role: 'assistant',
        text: contentText(m.content),
        tools,
        indices: [
          i,
          ...(m.tool_calls ?? []).map((tc) => results.get(tc.id)).filter(Number.isInteger),
        ],
      });
    }
  }
  return out;
}

function serialize(message) {
  if (message.role === 'user') return message.text ? `[User]: ${message.text}` : '';
  const parts = [];
  if (message.text) parts.push(`[Assistant]: ${message.text}`);
  for (const part of message.tools) {
    parts.push(`[Assistant tool call]: ${part.tool}(${JSON.stringify(part.input)})`);
    if (part.result) {
      const output = part.compacted
        ? '[Old tool result content cleared]'
        : truncate(contentText(part.result.content));
      parts.push(`[Tool result]: ${output}`);
    }
  }
  return parts.join('\n');
}

function usable() {
  const reserved = Math.min(COMPACTION_BUFFER, MODEL_LIMIT.output);
  return Math.max(0, MODEL_LIMIT.context - reserved);
}

function preserveRecentBudget() {
  return Math.min(
    MAX_PRESERVE_RECENT_TOKENS,
    Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable() * 0.25)),
  );
}

/** prune(): walk back over completed tool parts; past PRUNE_PROTECT tokens, clear older outputs. */
function prune(ocMessages) {
  let total = 0;
  let pruned = 0;
  const toPrune = [];
  let turns = 0;
  outer: for (let i = ocMessages.length - 1; i >= 0; i--) {
    const msg = ocMessages[i];
    if (msg.role === 'user') turns++;
    if (turns < 2) continue;
    if (msg.role !== 'assistant') continue;
    for (let p = msg.tools.length - 1; p >= 0; p--) {
      const part = msg.tools[p];
      if (!part.result) continue;
      if (part.compacted) break outer;
      const est = estimate(contentText(part.result.content));
      total += est;
      if (total <= PRUNE_PROTECT) continue;
      pruned += est;
      toPrune.push(part);
    }
  }
  if (pruned > PRUNE_MINIMUM) for (const part of toPrune) part.compacted = true;
  return toPrune.length && pruned > PRUNE_MINIMUM ? toPrune.length : 0;
}

/** select(): whole user-turns from the end while they fit the budget; keep.start 0 => no tail. */
function select(ocMessages) {
  const budget = preserveRecentBudget();
  const turns = [];
  for (let i = 0; i < ocMessages.length; i++)
    if (ocMessages[i].role === 'user') turns.push({ start: i, end: ocMessages.length });
  for (let i = 0; i < turns.length - 1; i++) turns[i].end = turns[i + 1].start;
  if (!turns.length) return { head: ocMessages, tailStart: undefined };
  const size = (from, to) => estimate(JSON.stringify(ocMessages.slice(from, to)));
  let total = 0;
  let keep;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    const s = size(turn.start, turn.end);
    if (total + s <= budget) {
      total += s;
      keep = turn.start;
      continue;
    }
    const remaining = budget - total;
    if (remaining > 0 && turn.end - turn.start > 1)
      for (let start = turn.start + 1; start < turn.end; start++)
        if (size(start, turn.end) <= remaining) {
          keep = start;
          break;
        }
    break;
  }
  if (keep === undefined || keep === 0) return { head: ocMessages, tailStart: undefined };
  return { head: ocMessages.slice(0, keep), tailStart: keep };
}

/** The kept tail as the original OpenAI message objects. */
function tailAsOriginal(messages, ocMessages, tailStart) {
  if (tailStart === undefined) return [];
  return ocMessages
    .slice(tailStart)
    .flatMap((m) => m.indices)
    .sort((a, b) => a - b)
    .map((i) => messages[i]);
}

export default {
  name: `opencode:${CLAUDE_MODEL}`,
  async run(input) {
    const messages = toOpenAIShape(input);
    const systemMessages = messages.filter((m) => m.role === 'system');
    const oc = toOpenCodeMessages(messages);
    const prunedCount = PRUNE_ENABLED ? prune(oc) : 0;
    const selected = select(oc);
    const conversation = selected.head.map(serialize).filter(Boolean).join('\n\n');
    const nextPrompt = buildPrompt({ previousSummary: undefined, context: [conversation] });
    const r = await anthropic(CLAUDE_MODEL, {
      system: PROMPT_COMPACTION,
      messages: [{ role: 'user', content: [{ type: 'text', text: nextPrompt }] }],
      maxTokens: Math.min(MODEL_LIMIT.output, OUTPUT_TOKEN_MAX),
    });
    console.error(
      `  opencode: head ${selected.head.length}/${oc.length} messages summarized, tail from ${selected.tailStart ?? 'none'}, pruned tool outputs ${prunedCount}${PRUNE_ENABLED ? '' : ' (prune off: config default)'}`,
    );
    return {
      output: [
        ...systemMessages,
        { role: 'assistant', content: r.text.trim() },
        ...tailAsOriginal(messages, oc, selected.tailStart),
        {
          role: 'user',
          content:
            'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.',
        },
      ],
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      latencyMs: r.latencyMs,
      costUsd: r.costUsd,
    };
  },
};
