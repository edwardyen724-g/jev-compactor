// Upstream: Aider chat-history summarization (`ChatSummary`).
// Source:   github.com/Aider-AI/aider main (fetched 2026-09-18), aider/history.py (summarize,
//   summarize_real, summarize_all — ported below), aider/prompts.py (`summarize` and
//   `summary_prefix`, verbatim below), aider/models.py (max_chat_history_tokens =
//   min(max(max_input_tokens / 16, 1024), 8192)). License: Apache-2.0.
// Algorithm (ported): if the history is within max_tokens nothing happens. Otherwise walk back from
//   the end collecting a tail under max_tokens / 2, move the split back so the head ends on an
//   assistant message, summarize the head (only USER and ASSISTANT text; tool messages and tool
//   calls do not exist in aider and are dropped) into ONE user message `summary_prefix + summary`,
//   and return summary + tail if that fits, else recurse on it (depth <= 3, then summarize all).
//   summarize() appends assistant "Ok." if the result does not end with an assistant turn.
// Fidelity: APPROXIMATE.
//   - Budget: max_tokens = max_chat_history_tokens = min(max(max_input_tokens / 16, 1024), 8192),
//     i.e. 8,192 for any model with >= 131k input (aider/models.py); override with
//     BENCH_AIDER_MAX_HISTORY_TOKENS. A transcript under 8,192 tokens is returned unchanged (aider
//     would not summarize it); only the trailing "Ok." rule still applies.
//   - Model: aider summarizes with [main_model.weak_model, main_model]. claude-sonnet-5 has no
//     MODEL_SETTINGS entry (aider main is from 2026-05-22; its generic Claude branch matches
//     "sonnet-4-" only), so weak_model_name is None and the weak model IS the main model —
//     claude-sonnet-5 here, which is therefore faithful. Token counts use 4 chars/token instead of
//     litellm's tokenizer.
//   - The transcript's system message is aider's system prompt (not in done_messages) and is
//     carried through unchanged.
// What survives: system message, the summary, the newest turns under half the budget verbatim.
import { anthropic, CLAUDE_MODEL, contentText, toOpenAIShape } from './_llm.mjs';

export const SUMMARIZE_PROMPT = `*Briefly* summarize this partial conversation about programming.
Include less detail about older parts and more detail about the most recent messages.
Start a new paragraph every time the topic changes!

This is only part of a longer conversation so *DO NOT* conclude the summary with language like "Finally, ...". Because the conversation continues after the summary.
The summary *MUST* include the function names, libraries, packages that are being discussed.
The summary *MUST* include the filenames that are being referenced by the assistant inside the \`\`\`...\`\`\` fenced code blocks!
The summaries *MUST NOT* include \`\`\`...\`\`\` fenced code blocks!

Phrase the summary with the USER in first person, telling the ASSISTANT about the conversation.
Write *as* the user.
The user should refer to the assistant as *you*.
Start the summary with "I asked you...".
`;
export const SUMMARY_PREFIX = 'I spoke to you previously about a number of things.\n';

const MODEL_MAX_INPUT_TOKENS = 1_000_000; // claude-sonnet-5
const MAX_CHAT_HISTORY_TOKENS = Number(
  process.env.BENCH_AIDER_MAX_HISTORY_TOKENS ??
    Math.min(Math.max(MODEL_MAX_INPUT_TOKENS / 16, 1024), 8192),
);
const tokenCount = (m) => Math.ceil(JSON.stringify(m).length / 4);

export class ChatSummary {
  constructor(maxTokens) {
    this.maxTokens = maxTokens;
    this.usage = { inputTokens: 0, outputTokens: 0, latencyMs: 0, costUsd: 0, calls: 0 };
  }
  tokenize(messages) {
    return messages.map((m) => [tokenCount(m), m]);
  }
  async summarize(messages) {
    messages = await this.summarizeReal(messages);
    if (messages.length && messages[messages.length - 1].role !== 'assistant')
      messages.push({ role: 'assistant', content: 'Ok.' });
    return messages;
  }
  async summarizeReal(messages, depth = 0) {
    const sized = this.tokenize(messages);
    const total = sized.reduce((s, [t]) => s + t, 0);
    if (total <= this.maxTokens && depth === 0) return messages;
    const minSplit = 4;
    if (messages.length <= minSplit || depth > 3) return this.summarizeAll(messages);
    let tailTokens = 0;
    let splitIndex = messages.length;
    const halfMax = Math.floor(this.maxTokens / 2);
    for (let i = sized.length - 1; i >= 0; i--) {
      const [tokens] = sized[i];
      if (tailTokens + tokens < halfMax) {
        tailTokens += tokens;
        splitIndex = i;
      } else break;
    }
    while (messages[splitIndex - 1].role !== 'assistant' && splitIndex > 1) splitIndex -= 1;
    if (splitIndex <= minSplit) return this.summarizeAll(messages);
    const tail = messages.slice(splitIndex);
    const sizedHead = sized.slice(0, splitIndex);
    const modelMax = MODEL_MAX_INPUT_TOKENS - 512;
    const keep = [];
    let running = 0;
    for (const [tokens, msg] of sizedHead) {
      running += tokens;
      if (running > modelMax) break;
      keep.push(msg);
    }
    const summary = await this.summarizeAll(keep);
    const summaryTokens = summary.reduce((s, m) => s + tokenCount(m), 0);
    const tailTok = sized.slice(splitIndex).reduce((s, [t]) => s + t, 0);
    if (summaryTokens + tailTok < this.maxTokens) return [...summary, ...tail];
    return this.summarizeReal([...summary, ...tail], depth + 1);
  }
  async summarizeAll(messages) {
    let content = '';
    for (const msg of messages) {
      const role = msg.role.toUpperCase();
      if (role !== 'USER' && role !== 'ASSISTANT') continue;
      content += `# ${role}\n`;
      content += contentText(msg.content);
      if (!content.endsWith('\n')) content += '\n';
    }
    const r = await anthropic(CLAUDE_MODEL, {
      system: SUMMARIZE_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: content }] }],
      maxTokens: 4096,
    });
    this.usage.inputTokens += r.inputTokens;
    this.usage.outputTokens += r.outputTokens;
    this.usage.latencyMs += r.latencyMs;
    this.usage.costUsd += r.costUsd;
    this.usage.calls++;
    return [{ role: 'user', content: SUMMARY_PREFIX + r.text }];
  }
}

export default {
  name: `aider:${CLAUDE_MODEL}`,
  async run(input) {
    const messages = toOpenAIShape(input);
    const systemMessages = messages.filter((m) => m.role === 'system');
    const done = messages.filter((m) => m.role !== 'system');
    const summarizer = new ChatSummary(MAX_CHAT_HISTORY_TOKENS);
    const out = await summarizer.summarize(done);
    console.error(
      `  aider: ${summarizer.usage.calls} summarization call(s), max_chat_history_tokens ${MAX_CHAT_HISTORY_TOKENS}${summarizer.usage.calls ? '' : ' (under the limit: aider would not summarize)'}`,
    );
    return {
      output: [...systemMessages, ...out],
      inputTokens: summarizer.usage.inputTokens,
      outputTokens: summarizer.usage.outputTokens,
      latencyMs: summarizer.usage.latencyMs,
      costUsd: summarizer.usage.costUsd,
    };
  },
};
