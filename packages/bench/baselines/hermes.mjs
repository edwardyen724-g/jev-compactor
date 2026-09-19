// Upstream: Hermes Agent (NousResearch/hermes-agent) `ContextCompressor` — automatic compression and
//   `/compress`.
// Source:   the read-only local checkout ~/.hermes/hermes-agent (v0.13.0, commit 825bd50e, 2026-05-11),
//   agent/context_compressor.py: SUMMARY_PREFIX, _summarize_tool_result, _prune_old_tool_results,
//   _find_tail_cut_by_tokens, _align_boundary_*, _ensure_last_user_message_in_tail,
//   _serialize_for_summary, _generate_summary (prompt verbatim below), compress,
//   _sanitize_tool_pairs. License: MIT.
// Algorithm (ported, in compress() order):
//   1. Prune: dedupe identical tool results (>= 200 chars) keeping the newest copy; outside the
//      protected tail (token budget with a 20-message floor) replace tool outputs > 200 chars with
//      a one-line "[tool] ran `cmd` -> …" summary and shorten tool-call arguments > 500 chars.
//   2. Head = first 3 messages (protect_first_n), pushed past any tool results.
//   3. Tail = newest messages within tail_token_budget = 20% of the compression threshold
//      (threshold = 50% of the context window), at least 3 messages, never splitting a tool group,
//      always containing the last user message; if the budget would protect everything the tail
//      shrinks to the 3-message floor so compression still happens.
//   4. Middle turns are serialized ([USER]/[ASSISTANT]/[TOOL RESULT id], 6,000-char cap per
//      message, tool args capped at 1,500) and summarized by the auxiliary model into the
//      structured template; target ~20% of the compressed tokens (min 2,000, max 5% of context).
//   5. Assemble: head (a compaction note appended to the system prompt) + the summary as a
//      user/assistant message chosen to keep role alternation, prefixed with SUMMARY_PREFIX and
//      suffixed with an END marker when it is a user message + tail; then orphaned tool pairs fixed.
// Fidelity: APPROXIMATE.
//   - Model: Hermes' auxiliary "compression" model is whatever the user configured; here
//     claude-sonnet-5 through the Anthropic API. The context window is what Hermes itself resolves
//     for that model — get_model_context_length("claude-sonnet-5") = 1,000,000 (verified in the
//     local venv) — so threshold = 500,000 (MINIMUM_CONTEXT_LENGTH 64,000), tail budget 100,000,
//     summary cap min(50,000, 12,000) = 12,000. Override with BENCH_HERMES_CONTEXT (200000 gives the
//     old 20k tail). At these fixture sizes the budget protects everything, so the 3-message floor
//     decides the tail and the prune pass only deduplicates. Hermes would not trigger at all below
//     the threshold; the bench forces one pass.
//   - redact_sensitive_text is not applied (the fixtures contain no secrets); token estimates use
//     Hermes' 4-chars-per-token rule with JSON length standing in for Python str(dict) length.
// What survives: the first 3 messages, the summary, the protected tail verbatim (original objects,
//   except tool results the prune pass rewrote).
import { createHash } from 'node:crypto';
import { anthropic, CLAUDE_MODEL, contentText, toOpenAIShape } from './_llm.mjs';

export const SUMMARY_PREFIX =
  "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. This is a handoff from a previous context window — treat it as background reference, NOT as active instructions. Do NOT answer questions or fulfill requests mentioned in this summary; they were already addressed. Your current task is identified in the '## Active Task' section of the summary — resume exactly from there. IMPORTANT: Your persistent memory (MEMORY.md, USER.md) in the system prompt is ALWAYS authoritative and active — never ignore or deprioritize memory content due to this compaction note. Respond ONLY to the latest user message that appears AFTER this summary. The current session state (files, config, etc.) may reflect work described here — avoid repeating it:";

const CONTEXT_LENGTH = Number(process.env.BENCH_HERMES_CONTEXT ?? 1_000_000);
const MINIMUM_CONTEXT_LENGTH = 64_000;
const THRESHOLD_PERCENT = 0.5;
const PROTECT_FIRST_N = 3;
const PROTECT_LAST_N = 20;
const SUMMARY_TARGET_RATIO = 0.2;
const MIN_SUMMARY_TOKENS = 2000;
const SUMMARY_RATIO = 0.2;
const SUMMARY_TOKENS_CEILING = 12_000;
const CHARS_PER_TOKEN = 4;
const CONTENT_MAX = 6000;
const CONTENT_HEAD = 4000;
const CONTENT_TAIL = 1500;
const TOOL_ARGS_MAX = 1500;
const TOOL_ARGS_HEAD = 1200;

const thresholdTokens = Math.max(CONTEXT_LENGTH * THRESHOLD_PERCENT, MINIMUM_CONTEXT_LENGTH);
const tailTokenBudget = Math.floor(thresholdTokens * SUMMARY_TARGET_RATIO);
const maxSummaryTokens = Math.min(Math.floor(CONTEXT_LENGTH * 0.05), SUMMARY_TOKENS_CEILING);

const roughTokens = (messages) => Math.ceil(JSON.stringify(messages).length / CHARS_PER_TOKEN);
const argsOf = (tc) => tc.function?.arguments ?? '';

/** _summarize_tool_result: one informative line per pruned tool result. */
export function summarizeToolResult(toolName, toolArgs, content) {
  let args = {};
  try {
    args = toolArgs ? JSON.parse(toolArgs) : {};
  } catch {
    args = {};
  }
  const len = content.length;
  const lines = content.trim() ? content.split('\n').length : 0;
  const n = (x) => x.toLocaleString('en-US');
  if (toolName === 'terminal') {
    let cmd = args.command ?? '';
    if (cmd.length > 80) cmd = `${cmd.slice(0, 77)}...`;
    const exit = /"exit_code"\s*:\s*(-?\d+)/.exec(content)?.[1] ?? '?';
    return `[terminal] ran \`${cmd}\` -> exit ${exit}, ${lines} lines output`;
  }
  if (toolName === 'read_file')
    return `[read_file] read ${args.path ?? '?'} from line ${args.offset ?? 1} (${n(len)} chars)`;
  if (toolName === 'write_file') {
    const written = args.content ? args.content.split('\n').length : '?';
    return `[write_file] wrote to ${args.path ?? '?'} (${written} lines)`;
  }
  if (toolName === 'search_files') {
    const count = /"total_count"\s*:\s*(\d+)/.exec(content)?.[1] ?? '?';
    return `[search_files] ${args.target ?? 'content'} search for '${args.pattern ?? '?'}' in ${args.path ?? '.'} -> ${count} matches`;
  }
  if (toolName === 'patch')
    return `[patch] ${args.mode ?? 'replace'} in ${args.path ?? '?'} (${n(len)} chars result)`;
  if (toolName === 'web_search')
    return `[web_search] query='${args.query ?? '?'}' (${n(len)} chars result)`;
  if (toolName === 'execute_code') {
    let preview = (args.code ?? '').slice(0, 60).replaceAll('\n', ' ');
    if ((args.code ?? '').length > 60) preview += '...';
    return `[execute_code] \`${preview}\` (${lines} lines output)`;
  }
  let first = '';
  for (const [k, v] of Object.entries(args).slice(0, 2)) first += ` ${k}=${String(v).slice(0, 40)}`;
  return `[${toolName}]${first} (${n(len)} chars result)`;
}

function truncateToolCallArgsJson(args, headChars = 200) {
  try {
    const obj = JSON.parse(args);
    const shrink = (v) => {
      if (typeof v === 'string' && v.length > headChars)
        return `${v.slice(0, headChars)}...[truncated ${v.length - headChars} chars]`;
      if (Array.isArray(v)) return v.map(shrink);
      if (v && typeof v === 'object')
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x)]));
      return v;
    };
    return JSON.stringify(shrink(obj));
  } catch {
    return `${args.slice(0, headChars)}...`;
  }
}

const msgTokens = (m) => {
  let t = Math.floor(contentText(m.content).length / CHARS_PER_TOKEN) + 10;
  for (const tc of m.tool_calls ?? []) t += Math.floor(argsOf(tc).length / CHARS_PER_TOKEN);
  return t;
};

/** _prune_old_tool_results with the token-budget tail. Returns [messages, prunedCount]. */
export function pruneOldToolResults(messages, protectTailCount, protectTailTokens) {
  const result = messages.map((m) => ({ ...m }));
  let pruned = 0;
  const callIdToTool = new Map();
  for (const m of result)
    if (m.role === 'assistant')
      for (const tc of m.tool_calls ?? [])
        callIdToTool.set(tc.id ?? '', [tc.function?.name ?? 'unknown', argsOf(tc)]);
  let pruneBoundary;
  if (protectTailTokens && protectTailTokens > 0) {
    let accumulated = 0;
    let boundary = result.length;
    const minProtect = Math.min(protectTailCount, result.length);
    for (let i = result.length - 1; i >= 0; i--) {
      const t = msgTokens(result[i]);
      if (accumulated + t > protectTailTokens && result.length - i >= minProtect) {
        boundary = i;
        break;
      }
      accumulated += t;
      boundary = i;
    }
    const protectedCount = Math.max(result.length - boundary, minProtect);
    pruneBoundary = result.length - protectedCount;
  } else pruneBoundary = result.length - protectTailCount;

  // Pass 1: dedupe identical tool results, newest copy wins.
  const seen = new Set();
  for (let i = result.length - 1; i >= 0; i--) {
    const m = result[i];
    if (m.role !== 'tool' || typeof m.content !== 'string' || m.content.length < 200) continue;
    const h = createHash('md5').update(m.content).digest('hex').slice(0, 12);
    if (seen.has(h)) {
      result[i] = { ...m, content: '[Duplicate tool output — same content as a more recent call]' };
      pruned++;
    } else seen.add(h);
  }
  // Pass 2: replace old tool results with one-line summaries.
  for (let i = 0; i < pruneBoundary; i++) {
    const m = result[i];
    if (m.role !== 'tool' || typeof m.content !== 'string') continue;
    if (!m.content || m.content.startsWith('[Duplicate tool output')) continue;
    if (m.content.length > 200) {
      const [name, args] = callIdToTool.get(m.tool_call_id ?? '') ?? ['unknown', ''];
      result[i] = { ...m, content: summarizeToolResult(name, args, m.content) };
      pruned++;
    }
  }
  // Pass 3: shorten large tool-call arguments outside the tail.
  for (let i = 0; i < pruneBoundary; i++) {
    const m = result[i];
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    let modified = false;
    const tcs = m.tool_calls.map((tc) => {
      const args = argsOf(tc);
      if (args.length > 500) {
        const next = truncateToolCallArgsJson(args);
        if (next !== args) {
          modified = true;
          return { ...tc, function: { ...tc.function, arguments: next } };
        }
      }
      return tc;
    });
    if (modified) result[i] = { ...m, tool_calls: tcs };
  }
  return [result, pruned];
}

const alignForward = (messages, idx) => {
  while (idx < messages.length && messages[idx].role === 'tool') idx++;
  return idx;
};
const alignBackward = (messages, idx) => {
  if (idx <= 0 || idx >= messages.length) return idx;
  let check = idx - 1;
  while (check >= 0 && messages[check].role === 'tool') check--;
  if (check >= 0 && messages[check].role === 'assistant' && messages[check].tool_calls?.length)
    return check;
  return idx;
};
function ensureLastUserInTail(messages, cutIdx, headEnd) {
  let last = -1;
  for (let i = messages.length - 1; i >= headEnd; i--)
    if (messages[i].role === 'user') {
      last = i;
      break;
    }
  if (last < 0 || last >= cutIdx) return cutIdx;
  return Math.max(last, headEnd + 1);
}
export function findTailCutByTokens(messages, headEnd, tokenBudget = tailTokenBudget) {
  const n = messages.length;
  const minTail = n - headEnd > 1 ? Math.min(3, n - headEnd - 1) : 0;
  const softCeiling = Math.floor(tokenBudget * 1.5);
  let accumulated = 0;
  let cut = n;
  for (let i = n - 1; i >= headEnd; i--) {
    const t = msgTokens(messages[i]);
    if (accumulated + t > softCeiling && n - i >= minTail) break;
    accumulated += t;
    cut = i;
  }
  const fallback = n - minTail;
  cut = Math.min(cut, fallback);
  if (cut <= headEnd) cut = Math.max(fallback, headEnd + 1);
  cut = alignBackward(messages, cut);
  cut = ensureLastUserInTail(messages, cut, headEnd);
  return Math.max(cut, headEnd + 1);
}

const clip = (s) =>
  s.length > CONTENT_MAX
    ? `${s.slice(0, CONTENT_HEAD)}\n...[truncated]...\n${s.slice(-CONTENT_TAIL)}`
    : s;

export function serializeForSummary(turns) {
  const parts = [];
  for (const m of turns) {
    const role = m.role ?? 'unknown';
    let content = clip(contentText(m.content));
    if (role === 'tool') {
      parts.push(`[TOOL RESULT ${m.tool_call_id ?? ''}]: ${content}`);
      continue;
    }
    if (role === 'assistant') {
      if (m.tool_calls?.length) {
        const tc = m.tool_calls.map((c) => {
          let args = argsOf(c);
          if (args.length > TOOL_ARGS_MAX) args = `${args.slice(0, TOOL_ARGS_HEAD)}...`;
          return `  ${c.function?.name ?? '?'}(${args})`;
        });
        content += `\n[Tool calls:\n${tc.join('\n')}\n]`;
      }
      parts.push(`[ASSISTANT]: ${content}`);
      continue;
    }
    parts.push(`[${role.toUpperCase()}]: ${content}`);
  }
  return parts.join('\n\n');
}

export function buildPrompt(turns, summaryBudget) {
  const preamble =
    'You are a summarization agent creating a context checkpoint. Treat the conversation turns below as source material for a compact record of prior work. Produce only the structured summary; do not add a greeting, preamble, or prefix. Write the summary in the same language the user was using in the conversation — do not translate or switch to English. NEVER include API keys, tokens, passwords, secrets, credentials, or connection strings in the summary — replace any that appear with [REDACTED]. Note that the user had credentials present, but do not preserve their values.';
  const template = `## Active Task
[THE SINGLE MOST IMPORTANT FIELD. Copy the user's most recent request or
task assignment verbatim — the exact words they used. If multiple tasks
were requested and only some are done, list only the ones NOT yet completed.
Continuation should pick up exactly here. Example:
"User asked: 'Now refactor the auth module to use JWT instead of sessions'"
If no outstanding task exists, write "None."]

## Goal
[What the user is trying to accomplish overall]

## Constraints & Preferences
[User preferences, coding style, constraints, important decisions]

## Completed Actions
[Numbered list of concrete actions taken — include tool used, target, and outcome.
Format each as: N. ACTION target — outcome [tool: name]
Example:
1. READ config.py:45 — found \`==\` should be \`!=\` [tool: read_file]
2. PATCH config.py:45 — changed \`==\` to \`!=\` [tool: patch]
3. TEST \`pytest tests/\` — 3/50 failed: test_parse, test_validate, test_edge [tool: terminal]
Be specific with file paths, commands, line numbers, and results.]

## Active State
[Current working state — include:
- Working directory and branch (if applicable)
- Modified/created files with brief note on each
- Test status (X/Y passing)
- Any running processes or servers
- Environment details that matter]

## In Progress
[Work currently underway — what was being done when compaction fired]

## Blocked
[Any blockers, errors, or issues not yet resolved. Include exact error messages.]

## Key Decisions
[Important technical decisions and WHY they were made]

## Resolved Questions
[Questions the user asked that were ALREADY answered — include the answer so it is not repeated]

## Pending User Asks
[Questions or requests from the user that have NOT yet been answered or fulfilled. If none, write "None."]

## Relevant Files
[Files read, modified, or created — with brief note on each]

## Remaining Work
[What remains to be done — framed as context, not instructions]

## Critical Context
[Any specific values, error messages, configuration details, or data that would be lost without explicit preservation. NEVER include API keys, tokens, passwords, or credentials — write [REDACTED] instead.]

Target ~${summaryBudget} tokens. Be CONCRETE — include file paths, command outputs, error messages, line numbers, and specific values. Avoid vague descriptions like "made some changes" — say exactly what changed.

Write only the summary body. Do not include any preamble or prefix.`;
  return `${preamble}

Create a structured checkpoint summary for the conversation after earlier turns are compacted. The summary should preserve enough detail for continuity without re-reading the original turns.

TURNS TO SUMMARIZE:
${serializeForSummary(turns)}

Use this exact structure:

${template}`;
}

/** _sanitize_tool_pairs: drop orphaned results, stub missing ones. */
export function sanitizeToolPairs(messages) {
  const calls = new Set();
  const results = new Set();
  for (const m of messages) {
    if (m.role === 'assistant') for (const tc of m.tool_calls ?? []) if (tc.id) calls.add(tc.id);
    if (m.role === 'tool' && m.tool_call_id) results.add(m.tool_call_id);
  }
  let out = messages.filter((m) => !(m.role === 'tool' && !calls.has(m.tool_call_id)));
  const missing = [...calls].filter((id) => !results.has(id));
  if (missing.length) {
    const patched = [];
    for (const m of out) {
      patched.push(m);
      if (m.role === 'assistant')
        for (const tc of m.tool_calls ?? [])
          if (missing.includes(tc.id))
            patched.push({
              role: 'tool',
              content: '[Result from earlier conversation — see context summary above]',
              tool_call_id: tc.id,
            });
    }
    out = patched;
  }
  return out;
}

export default {
  name: `hermes:${CLAUDE_MODEL}`,
  async run(raw) {
    const input = toOpenAIShape(raw);
    if (input.length <= PROTECT_FIRST_N + 3 + 1) throw new Error('too few messages to compress');
    const [messages, prunedCount] = pruneOldToolResults(input, PROTECT_LAST_N, tailTokenBudget);
    const compressStart = alignForward(messages, PROTECT_FIRST_N);
    const compressEnd = findTailCutByTokens(messages, compressStart);
    if (compressStart >= compressEnd) throw new Error('nothing to compress');
    const turns = messages.slice(compressStart, compressEnd);
    const contentTokens = roughTokens(turns);
    const summaryBudget = Math.max(
      MIN_SUMMARY_TOKENS,
      Math.min(Math.floor(contentTokens * SUMMARY_RATIO), maxSummaryTokens),
    );
    const r = await anthropic(CLAUDE_MODEL, {
      messages: [
        { role: 'user', content: [{ type: 'text', text: buildPrompt(turns, summaryBudget) }] },
      ],
      maxTokens: Math.floor(summaryBudget * 1.3),
    });
    let summary = `${SUMMARY_PREFIX}\n${r.text.trim()}`;

    const compressed = [];
    for (let i = 0; i < compressStart; i++) {
      const m = { ...messages[i] };
      if (i === 0 && m.role === 'system') {
        const note =
          '[Note: Some earlier conversation turns have been compacted into a handoff summary to preserve context space. The current session state may still reflect earlier work, so build on that summary and state rather than re-doing work. Your persistent memory (MEMORY.md, USER.md) remains fully authoritative regardless of compaction.]';
        const existing = contentText(m.content);
        if (!existing.includes(note)) m.content = existing ? `${existing}\n\n${note}` : note;
      }
      compressed.push(i === 0 && m.role === 'system' ? m : messages[i]);
    }
    const lastHeadRole = compressStart > 0 ? (messages[compressStart - 1].role ?? 'user') : 'user';
    const firstTailRole =
      compressEnd < messages.length ? (messages[compressEnd].role ?? 'user') : 'user';
    let summaryRole =
      lastHeadRole === 'assistant' || lastHeadRole === 'tool' ? 'user' : 'assistant';
    let mergeIntoTail = false;
    if (summaryRole === firstTailRole) {
      const flipped = summaryRole === 'user' ? 'assistant' : 'user';
      if (flipped !== lastHeadRole) summaryRole = flipped;
      else mergeIntoTail = true;
    }
    const END =
      '\n\n--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---';
    if (!mergeIntoTail && summaryRole === 'user') summary += END;
    if (!mergeIntoTail) compressed.push({ role: summaryRole, content: summary });
    for (let i = compressEnd; i < messages.length; i++) {
      if (mergeIntoTail && i === compressEnd) {
        compressed.push({
          ...messages[i],
          content: `${summary}${END}\n\n${contentText(messages[i].content)}`,
        });
        mergeIntoTail = false;
      } else compressed.push(messages[i]);
    }
    const output = sanitizeToolPairs(compressed);
    console.error(
      `  hermes: pruned ${prunedCount} tool results, summarized ${compressStart}..${compressEnd} of ${messages.length}, summary role ${summaryRole}, budget ~${summaryBudget} tokens`,
    );
    return {
      output,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      latencyMs: r.latencyMs,
      costUsd: r.costUsd,
    };
  },
};
