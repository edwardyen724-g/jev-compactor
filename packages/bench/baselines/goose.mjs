// Upstream: Block's goose — conversation compaction (auto at 80% of the context limit, and
//   `/compact` / "summarize").
// Source:   github.com/block/goose main (tree sha ba8ba0ca, fetched 2026-09-19),
//   crates/goose-context-management/src/{summarize.rs,format.rs,structured.rs,templates.rs} and
//   prompts/{compaction.md,compaction_summary.md} (verbatim below); crates/goose/src/context_mgmt/
//   mod.rs compact_messages (continuation assembly). License: Apache-2.0.
// Algorithm (ported): every message is rendered as "[user|assistant]: …" with tool_request(name):
//   {args} / tool_response: text lines and spliced into the compaction.md SYSTEM prompt; the only
//   user message is "Please summarize the conversation history provided in the system prompt."
//   The reply's ```json block is parsed as a StructuredSummary and rendered through the
//   compaction_summary.md minijinja template (raw text kept when parsing fails; candidates are the
//   ```json fences after the last </analysis>, last fence first); the result becomes a USER
//   message. The conversation after compaction (auto-compaction path, manual_compact = false) is
//   [summary (user), assistant continuation notice, the last text-only user message replayed]. The
//   notice is CONVERSATION_CONTINUATION_TEXT when that user message is the newest message, else
//   TOOL_LOOP_CONTINUATION_TEXT ("Continue calling tools as necessary…"). On context overflow goose
//   retries with 0/10/20/50/100% of tool responses removed from the middle; the first attempt (0%)
//   is what runs here. The rendered system prompt is trimmed (templates.rs render()).
// Fidelity: APPROXIMATE.
//   - Model: goose uses the session's provider/model; here claude-sonnet-5 via the Anthropic API.
//   - The transcript's system message is goose's own system prompt (out of band) and is carried
//     through unchanged. Thinking blocks, images and documents do not occur in the fixtures.
// What survives: the system message, the rendered summary, the continuation notice, the last
//   user message verbatim (the caller's object).
import { anthropic, CLAUDE_MODEL, contentText, parseArgs, toOpenAIShape } from './_llm.mjs';

export const COMPACTION_TEMPLATE = `## Task Context
- An llm context limit was reached when a user was in a working session with an agent (you)
- Distill the conversation below into a structured summary with only the most verbose parts removed
- Include user requests, your responses, all technical content, and as much of the original context as possible
- This will be used to let the user continue the working session
- The summary will be read by an agent (you) on a next exchange to allow for continuation of the session

**Conversation History:**
{{ messages }}

Wrap reasoning in \`<analysis>\` tags:
- Review conversation chronologically: user goals, your methods, key decisions, files, errors, fixes
- Keep this brief - the analysis is discarded, so it is a checklist of what to include, not the place for detail

After the closing \`</analysis>\` tag, output exactly one \`\`\`json code block and nothing else, matching this schema:

\`\`\`json
{
  "user_intent": ["every user goal and request, most important first"],
  "technical_concepts": ["all discussed tools, methods, and concepts"],
  "files": [
    {
      "path": "path of a file that was viewed or edited",
      "summary": "what was done to it and why",
      "key_code": "important code, signatures, or diffs from this file (omit if none)"
    }
  ],
  "errors_and_fixes": ["bugs hit, their resolutions, and user-driven changes"],
  "problem_solving": ["issues solved or in progress, and key decisions: what was chosen, what was rejected, and why"],
  "user_messages": ["all user messages, truncating long tool call arguments or results"],
  "pending_tasks": ["all unresolved user requests, most important first"],
  "current_work": "active work at summary request time: filenames, code, alignment to latest instruction",
  "next_step": "include only if it directly continues a user instruction, otherwise omit"
}
\`\`\`

Rules for the JSON:
- The \`<analysis>\` block is a discarded scratchpad: only the JSON survives, so it must be self-contained and repeat every detail from the analysis that matters for continuing
- Order every list from most to least important
- Every list entry must be a plain string, not a nested object - except \`files\`, whose entries are objects shaped as shown above
- Quote error messages, panic text, and failing test output verbatim in \`errors_and_fixes\` - exact strings including numbers, identifiers, and paths, not paraphrases
- This summary will only be read by you, so it is ok to make it much longer than a normal summary you would show to a human: spend your entire length budget on the JSON fields, and quote liberally - full output blocks, complete code snippets, exact user wording
- Do not exclude any information that might be important to continuing a session working with you
- Omit a field rather than inventing content for it
- No new ideas unless user confirmed
`;

const SUMMARIZE_REQUEST_TEXT =
  'Please summarize the conversation history provided in the system prompt.';
const CONVERSATION_CONTINUATION_TEXT = `Your context was compacted. The previous message contains a summary of the conversation so far.
Do not mention that you read a summary or that conversation summarization occurred.
Just continue the conversation naturally based on the summarized context.`;
const TOOL_LOOP_CONTINUATION_TEXT = `Your context was compacted. The previous message contains a summary of the conversation so far.
Do not mention that you read a summary or that conversation summarization occurred.
Continue calling tools as necessary to complete the task.`;

/** format_message_for_compacting for the content kinds an OpenAI transcript can carry. */
export function formatMessageForCompacting(m) {
  const parts = [];
  const text = contentText(m.content);
  if (m.role === 'tool') {
    parts.push(text ? `tool_response: ${text}` : 'tool_response: [non-text content]');
  } else {
    if (text) parts.push(text);
    for (const tc of m.tool_calls ?? [])
      parts.push(
        `tool_request(${tc.function?.name ?? '?'}): ${JSON.stringify(parseArgs(tc.function?.arguments))}`,
      );
  }
  const role = m.role === 'assistant' ? 'assistant' : 'user';
  return parts.length ? `[${role}]: ${parts.join('\n')}` : `[${role}]: <empty message>`;
}

/** templates.rs code_fence filter. */
function codeFence(code) {
  let max = 0;
  let run = 0;
  for (const c of code) {
    run = c === '`' ? run + 1 : 0;
    if (run > max) max = run;
  }
  const fence = '`'.repeat(Math.max(max + 1, 3));
  return `${fence}\n${code.replace(/\n+$/, '')}\n${fence}`;
}

const asList = (v) =>
  (Array.isArray(v) ? v : v == null ? [] : [v])
    .map((x) => (typeof x === 'string' ? x : x == null ? '' : JSON.stringify(x)))
    .filter((s) => s.trim());

/**
 * StructuredSummary::parse via json_candidates: the text after the LAST </analysis> (or the whole
 * text), every ```json fence in it tried last-first, then a leading bare object; the first
 * candidate that parses to a non-empty object wins.
 */
export function parseStructuredSummary(text) {
  const term = '</analysis>';
  const cut = text.lastIndexOf(term);
  const tail = cut === -1 ? text : text.slice(cut + term.length);
  const fences = [...tail.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]).reverse();
  const lead = /^\s*(\{[\s\S]*\})\s*$/.exec(tail);
  const candidates = [...fences, ...(lead ? [lead[1]] : [])];
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) return v;
    } catch {}
  }
  return undefined;
}

/** compaction_summary.md rendered the way minijinja renders it (blank sections omitted). */
export function renderSummary(s) {
  const out = ['# Conversation Summary', ''];
  const list = (title, items) => {
    if (!items.length) return;
    out.push(`## ${title}`);
    for (const i of items) out.push(`- ${i}`);
    out.push('');
  };
  list('User Intent', asList(s.user_intent));
  list('Technical Concepts', asList(s.technical_concepts));
  const files = (Array.isArray(s.files) ? s.files : []).filter((f) => f && typeof f === 'object');
  if (files.length) {
    out.push('## Files + Code');
    for (const f of files) {
      if (f.path) out.push(`### ${f.path}`);
      out.push(String(f.summary ?? ''));
      if (f.key_code) out.push(codeFence(String(f.key_code)));
      out.push('');
    }
  }
  list('Errors + Fixes', asList(s.errors_and_fixes));
  list('Problem Solving', asList(s.problem_solving));
  list('User Messages', asList(s.user_messages));
  list('Pending Tasks', asList(s.pending_tasks));
  if (s.current_work && String(s.current_work).trim())
    out.push('## Current Work', String(s.current_work), '');
  if (s.next_step && String(s.next_step).trim()) out.push('## Next Step', String(s.next_step));
  return out.join('\n').trim();
}

export default {
  name: `goose:${CLAUDE_MODEL}`,
  async run(input) {
    const messages = toOpenAIShape(input);
    const systemMessages = messages.filter((m) => m.role === 'system');
    const conversation = messages.filter((m) => m.role !== 'system');
    const rendered = conversation.map(formatMessageForCompacting).join('\n');
    const systemPrompt = COMPACTION_TEMPLATE.replace('{{ messages }}', rendered).trim();
    const r = await anthropic(CLAUDE_MODEL, {
      system: systemPrompt,
      messages: [{ role: 'user', content: [{ type: 'text', text: SUMMARIZE_REQUEST_TEXT }] }],
      maxTokens: 8192,
    });
    const structured = parseStructuredSummary(r.text);
    const summaryText = structured ? renderSummary(structured) || r.text.trim() : r.text.trim();
    // The last agent-visible, text-only user message is replayed after the continuation notice.
    const lastUserIdx = conversation.findLastIndex(
      (m) => m.role === 'user' && contentText(m.content),
    );
    const lastUser = lastUserIdx === -1 ? undefined : conversation[lastUserIdx];
    const isMostRecent = lastUserIdx === conversation.length - 1;
    const continuation = isMostRecent
      ? CONVERSATION_CONTINUATION_TEXT
      : TOOL_LOOP_CONTINUATION_TEXT;
    console.error(
      `  goose: structured JSON ${structured ? 'parsed' : 'NOT parsed (raw text kept)'}`,
    );
    return {
      output: [
        ...systemMessages,
        { role: 'user', content: summaryText },
        { role: 'assistant', content: continuation },
        ...(lastUser ? [lastUser] : []),
      ],
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      latencyMs: r.latencyMs,
      costUsd: r.costUsd,
    };
  },
};
