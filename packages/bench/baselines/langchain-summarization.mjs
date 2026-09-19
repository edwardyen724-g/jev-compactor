// Upstream: LangChain (Python) agents `SummarizationMiddleware`.
// Source:   github.com/langchain-ai/langchain @ bc16168d710d8b594d0bc622c70361876bd9cbda
//   (2026-08-07, langchain 1.4.2), libs/langchain_v1/langchain/agents/middleware/summarization.py:
//   DEFAULT_SUMMARY_PROMPT (verbatim below), keep=("messages", 20), trim_tokens_to_summarize=4000,
//   _find_safe_cutoff / _find_safe_cutoff_point, _trim_messages_for_summary, _build_new_messages;
//   libs/core/langchain_core/messages/utils.py get_buffer_string(format="xml"),
//   count_tokens_approximately (chars_per_token 3.3 for Anthropic chat models, +3 per message).
//   License: MIT.
// Algorithm (ported): cutoff = len(messages) - 20, moved back to the AIMessage that issued the
//   tool calls if it would land on a ToolMessage. messages[:cutoff] are summarized, but first
//   trimmed to the LAST 4,000 approximate tokens (strategy "last", start_on "human", system message
//   kept, partial messages allowed line by line), serialized as <message type="…"> XML and spliced
//   into the prompt as a single human message. The summary replaces everything before the cutoff as
//   HumanMessage("Here is a summary of the conversation to date:\n\n…"); messages[cutoff:] are kept
//   as the caller's objects. The trigger (when to run) is not modelled: the bench always compacts.
// Fidelity: APPROXIMATE.
//   - Model: the user's; claude-sonnet-5 through the Anthropic API (ChatAnthropic in LangChain),
//     so the 3.3 chars/token counter branch applies. ChatAnthropic's max_tokens defaults to the
//     model profile's max_output_tokens (langchain_anthropic/data/_profiles.py: 128,000 for
//     claude-sonnet-5), so the summary call is sent with max_tokens 128000. Retry-on-failure and
//     usage-metadata scaling (no usage on fixture messages) are not modelled.
//   - The transcript's system message is the agent's system prompt (not part of state["messages"]
//     in create_agent) and is carried through unchanged; the cutoff counts the other messages.
//   - Python repr() of tool_calls is approximated by JSON when counting tokens; json.dumps spacing
//     is reproduced for the XML tool_call arguments.
// What survives: system message, the summary as a human message, the last 20 messages verbatim.
import { anthropic, CLAUDE_MODEL, contentText, parseArgs, toOpenAIShape } from './_llm.mjs';

export const DEFAULT_SUMMARY_PROMPT = `<role>
Context Extraction Assistant
</role>

<primary_objective>
Your sole objective in this task is to extract the highest quality/most relevant context from the conversation history below.
</primary_objective>

<objective_information>
You're nearing the total number of input tokens you can accept, so you must extract the highest quality/most relevant pieces of information from your conversation history.
This context will then overwrite the conversation history presented below. Because of this, ensure the context you extract is only the most important information to continue working toward your overall goal.
</objective_information>

<instructions>
The conversation history below will be replaced with the context you extract in this step.
You want to ensure that you don't repeat any actions you've already completed, so the context you extract from the conversation history should be focused on the most important information to your overall goal.

You should structure your summary using the following sections. Each section acts as a checklist - you must populate it with relevant information or explicitly state "None" if there is nothing to report for that section:

## SESSION INTENT

What is the user's primary goal or request? What overall task are you trying to accomplish? This should be concise but complete enough to understand the purpose of the entire session.

## SUMMARY

Extract and record all of the most important context from the conversation history. Include important choices, conclusions, or strategies determined during this conversation. Include the reasoning behind key decisions. Document any rejected options and why they were not pursued.

## ARTIFACTS

What artifacts, files, or resources were created, modified, or accessed during this conversation? For file modifications, list specific file paths and briefly describe the changes made to each. This section prevents silent loss of artifact information.

## NEXT STEPS

What specific tasks remain to be completed to achieve the session intent? What should you do next?

</instructions>

The user will message you with the full message history from which you'll extract context to create a replacement. Carefully read through it all and think deeply about what information is most important to your overall goal and should be saved:

With all of this in mind, please carefully read over the entire conversation history, and extract the most important and relevant context to replace it so that you can free up space in the conversation history.
Respond ONLY with the extracted context. Do not include any additional information, or text before or after the extracted context.

<messages>
Messages to summarize:
{messages}
</messages>`;

const DEFAULT_MESSAGES_TO_KEEP = 20;
const DEFAULT_TRIM_TOKEN_LIMIT = 4000;
const CHARS_PER_TOKEN = 3.3; // _get_approximate_token_counter for anthropic-chat models
const EXTRA_TOKENS_PER_MESSAGE = 3;

// ── LangChain message view of the OpenAI transcript ──
const lcType = (m) =>
  m.role === 'user'
    ? 'human'
    : m.role === 'assistant'
      ? 'ai'
      : m.role === 'tool'
        ? 'tool'
        : 'system';
const toolCallsOf = (m) =>
  (m.tool_calls ?? []).map((tc) => ({
    name: tc.function?.name ?? '',
    args: parseArgs(tc.function?.arguments),
    id: tc.id,
    type: 'tool_call',
  }));
const openaiRole = (m) => (m.role === 'user' ? 'user' : m.role);

/** count_tokens_approximately for one message (rounded up per message, +3). */
function messageTokens(m) {
  let chars = contentText(m.content).length;
  const tcs = toolCallsOf(m);
  if (m.role === 'assistant' && tcs.length) chars += pyRepr(tcs).length;
  if (m.role === 'tool') chars += String(m.tool_call_id ?? '').length;
  chars += openaiRole(m).length;
  if (m.name) chars += String(m.name).length;
  return Math.ceil(chars / CHARS_PER_TOKEN) + EXTRA_TOKENS_PER_MESSAGE;
}
const countTokens = (messages) => messages.reduce((s, m) => s + messageTokens(m), 0);

/** Python json.dumps default spacing: ", " and ": ". */
export function pyJsonDumps(v) {
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(pyJsonDumps).join(', ')}]`;
  return `{${Object.entries(v)
    .map(([k, val]) => `${JSON.stringify(k)}: ${pyJsonDumps(val)}`)
    .join(', ')}}`;
}
/** Rough Python repr() of a list of dicts (single quotes), enough for character counting. */
function pyRepr(v) {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'string') return `'${v.replaceAll("'", "\\'")}'`;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`;
  return `{${Object.entries(v)
    .map(([k, val]) => `${pyRepr(k)}: ${pyRepr(val)}`)
    .join(', ')}}`;
}

const xmlEscape = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const quoteattr = (s) => `"${xmlEscape(s).replaceAll('"', '&quot;')}"`;

/** get_buffer_string(messages, format="xml") for the messages this transcript can contain. */
export function getBufferStringXml(messages) {
  return messages
    .map((m) => {
      const msgType = lcType(m);
      const text = contentText(m.content);
      const contentParts = text ? [xmlEscape(text)] : [];
      const tcs = toolCallsOf(m);
      if (m.role === 'assistant' && tcs.length) {
        const parts = [`<message type=${quoteattr(msgType)}>`];
        if (contentParts.length) parts.push(`  <content>${contentParts.join(' ')}</content>`);
        for (const tc of tcs)
          parts.push(
            `  <tool_call id=${quoteattr(String(tc.id ?? ''))} name=${quoteattr(String(tc.name ?? ''))}>${xmlEscape(pyJsonDumps(tc.args ?? {}))}</tool_call>`,
          );
        parts.push('</message>');
        return parts.join('\n');
      }
      return `<message type=${quoteattr(msgType)}>${contentParts.join(' ')}</message>`;
    })
    .join('\n');
}

/** _find_safe_cutoff + _find_safe_cutoff_point. */
export function findSafeCutoff(messages, messagesToKeep) {
  if (messages.length <= messagesToKeep) return 0;
  const cutoff = messages.length - messagesToKeep;
  if (cutoff >= messages.length || messages[cutoff].role !== 'tool') return cutoff;
  const ids = new Set();
  let idx = cutoff;
  while (idx < messages.length && messages[idx].role === 'tool') {
    if (messages[idx].tool_call_id) ids.add(messages[idx].tool_call_id);
    idx++;
  }
  for (let i = cutoff - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const own = new Set(m.tool_calls.map((tc) => tc.id).filter(Boolean));
      if ([...ids].some((id) => own.has(id))) return i;
    }
  }
  return idx;
}

/**
 * trim_messages(max_tokens=4000, strategy="last", start_on="human", include_system=True,
 * allow_partial=True): keep the system message, then the newest messages that fit; the message
 * that crosses the budget is included partially by trailing lines; then drop leading messages
 * until a human one.
 */
export function trimMessagesForSummary(messages) {
  let budget = DEFAULT_TRIM_TOKEN_LIMIT;
  const system = messages[0]?.role === 'system' ? messages[0] : undefined;
  const rest = system ? messages.slice(1) : messages;
  if (system) budget -= messageTokens(system);
  const kept = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const m = rest[i];
    const t = messageTokens(m);
    if (t <= budget) {
      kept.unshift(m);
      budget -= t;
      continue;
    }
    const lines = contentText(m.content).split('\n');
    const partial = [];
    for (let j = lines.length - 1; j >= 0; j--) {
      const candidate = { ...m, content: [lines[j], ...partial].join('\n') };
      if (messageTokens(candidate) > budget) break;
      partial.unshift(lines[j]);
    }
    if (partial.length) kept.unshift({ ...m, content: partial.join('\n') });
    break;
  }
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return system ? [system, ...kept] : kept;
}

export default {
  name: `langchain-summarization:${CLAUDE_MODEL}`,
  async run(input) {
    const messages = toOpenAIShape(input);
    const systemMessages = messages.filter((m) => m.role === 'system');
    const state = messages.filter((m) => m.role !== 'system');
    const cutoff = findSafeCutoff(state, DEFAULT_MESSAGES_TO_KEEP);
    if (cutoff <= 0) throw new Error('nothing to summarize (cutoff 0)');
    const toSummarize = state.slice(0, cutoff);
    const preserved = state.slice(cutoff);
    const trimmed = trimMessagesForSummary(toSummarize);
    const formatted = getBufferStringXml(trimmed);
    const prompt = DEFAULT_SUMMARY_PROMPT.replace('{messages}', formatted).trimEnd();
    const r = await anthropic(CLAUDE_MODEL, {
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: 128_000,
    });
    console.error(
      `  langchain: cutoff ${cutoff}/${state.length}, summarizer saw ${trimmed.length} of ${toSummarize.length} messages (${countTokens(trimmed)} approx tokens)`,
    );
    return {
      output: [
        ...systemMessages,
        {
          role: 'user',
          content: `Here is a summary of the conversation to date:\n\n${r.text.trim()}`,
        },
        ...preserved,
      ],
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      latencyMs: r.latencyMs,
      costUsd: r.costUsd,
    };
  },
};
