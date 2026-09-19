// Upstream: Vercel AI SDK `pruneMessages` — structural pruning, no model.
// Source:   npm `ai` 7.0.107, github.com/vercel/ai @ 03c3e3384b2777b7fb060522e48ca7f54d594d1b
//   (2026-09-17), packages/ai/src/generate-text/prune-messages.ts (ported line for line below) and
//   content/docs/07-reference/01-ai-sdk-core/prune-messages.mdx. License: Apache-2.0.
// Algorithm (exact): `reasoning` drops reasoning parts from assistant messages ('all' or all but
//   the last message); `toolCalls` drops tool-call / tool-result / tool-approval parts everywhere
//   except the last N messages, keeping any part whose call id or approval id is still referenced
//   from those N; `emptyMessages: 'remove'` drops messages left with no content.
// Configuration: the defaults (reasoning 'none', toolCalls []) prune nothing, so this control runs
//   the configuration the SDK's own reference page shows in its route handler example:
//   { reasoning: 'before-last-message', toolCalls: 'before-last-2-messages', emptyMessages:
//   'remove' }. BENCH_AI_SDK_TOOLCALLS overrides the toolCalls strategy.
// Fidelity: EXACT for the function; the transcript is converted to the SDK's ModelMessage shape
//   (tool_calls -> tool-call parts, tool messages -> tool-result parts), pruned, and converted back
//   to the fixture's OpenAI shape so the benchmark can read it (a lossless round trip; unchanged
//   messages are returned as the caller's objects).
// What survives: every user, system and assistant text; tool calls and results only in the last
//   two messages; anything referencing those calls.
import { contentText, parseArgs, toOpenAIShape } from './_llm.mjs';

export function pruneMessages({
  messages,
  reasoning = 'none',
  toolCalls = [],
  emptyMessages = 'remove',
}) {
  if (reasoning === 'all' || reasoning === 'before-last-message') {
    messages = messages.map((message, messageIndex) => {
      if (
        message.role !== 'assistant' ||
        typeof message.content === 'string' ||
        (reasoning === 'before-last-message' && messageIndex === messages.length - 1)
      )
        return message;
      return { ...message, content: message.content.filter((part) => part.type !== 'reasoning') };
    });
  }

  if (toolCalls === 'none') toolCalls = [];
  else if (toolCalls === 'all') toolCalls = [{ type: 'all' }];
  else if (toolCalls === 'before-last-message') toolCalls = [{ type: 'before-last-message' }];
  else if (typeof toolCalls === 'string') toolCalls = [{ type: toolCalls }];

  for (const toolCall of toolCalls) {
    const keepLastMessagesCount =
      toolCall.type === 'all'
        ? undefined
        : toolCall.type === 'before-last-message'
          ? 1
          : Number(toolCall.type.slice('before-last-'.length).slice(0, -'-messages'.length));

    const keptToolCallIds = new Set();
    const keptApprovalIds = new Set();
    if (keepLastMessagesCount != null) {
      for (const message of messages.slice(-keepLastMessagesCount)) {
        if (
          (message.role === 'assistant' || message.role === 'tool') &&
          typeof message.content !== 'string'
        ) {
          for (const part of message.content) {
            if (part.type === 'tool-call' || part.type === 'tool-result')
              keptToolCallIds.add(part.toolCallId);
            else if (
              part.type === 'tool-approval-request' ||
              part.type === 'tool-approval-response'
            )
              keptApprovalIds.add(part.approvalId);
          }
        }
      }
    }

    const toolCallIdToToolName = new Map();
    for (const message of messages) {
      if (
        (message.role === 'assistant' || message.role === 'tool') &&
        typeof message.content !== 'string'
      ) {
        for (const part of message.content) {
          if (part.type === 'tool-call' || part.type === 'tool-result')
            toolCallIdToToolName.set(part.toolCallId, part.toolName);
        }
      }
    }
    const approvalIdToToolCallId = new Map();
    const approvalIdToToolName = new Map();
    for (const message of messages) {
      if (
        (message.role === 'assistant' || message.role === 'tool') &&
        typeof message.content !== 'string'
      ) {
        for (const part of message.content) {
          if (part.type === 'tool-approval-request') {
            approvalIdToToolCallId.set(part.approvalId, part.toolCallId);
            const toolName = toolCallIdToToolName.get(part.toolCallId);
            if (toolName != null) approvalIdToToolName.set(part.approvalId, toolName);
          }
        }
      }
    }
    for (const approvalId of keptApprovalIds) {
      const toolCallId = approvalIdToToolCallId.get(approvalId);
      if (toolCallId != null) keptToolCallIds.add(toolCallId);
    }

    messages = messages.map((message, messageIndex) => {
      if (
        (message.role !== 'assistant' && message.role !== 'tool') ||
        typeof message.content === 'string' ||
        (keepLastMessagesCount && messageIndex >= messages.length - keepLastMessagesCount)
      )
        return message;
      return {
        ...message,
        content: message.content.filter((part) => {
          if (
            part.type !== 'tool-call' &&
            part.type !== 'tool-result' &&
            part.type !== 'tool-approval-request' &&
            part.type !== 'tool-approval-response'
          )
            return true;
          if (
            ((part.type === 'tool-call' || part.type === 'tool-result') &&
              keptToolCallIds.has(part.toolCallId)) ||
            ((part.type === 'tool-approval-request' || part.type === 'tool-approval-response') &&
              keptApprovalIds.has(part.approvalId))
          )
            return true;
          const partToolName =
            part.type === 'tool-call' || part.type === 'tool-result'
              ? part.toolName
              : approvalIdToToolName.get(part.approvalId);
          return (
            toolCall.tools != null && partToolName != null && !toolCall.tools.includes(partToolName)
          );
        }),
      };
    });
  }

  if (emptyMessages === 'remove')
    messages = messages.filter((message) => message.content.length > 0);
  return messages;
}

/** OpenAI transcript -> AI SDK ModelMessage[] (keeping a pointer to the source message). */
export function toModelMessages(messages) {
  const names = new Map();
  for (const m of messages)
    for (const tc of m.tool_calls ?? []) names.set(tc.id, tc.function?.name ?? 'tool');
  return messages.map((m, i) => {
    if (m.role === 'system') return { role: 'system', content: contentText(m.content), _source: i };
    if (m.role === 'user') return { role: 'user', content: contentText(m.content), _source: i };
    if (m.role === 'assistant') {
      const content = [];
      const text = contentText(m.content);
      if (text) content.push({ type: 'text', text });
      for (const tc of m.tool_calls ?? [])
        content.push({
          type: 'tool-call',
          toolCallId: tc.id,
          toolName: tc.function?.name ?? 'tool',
          input: parseArgs(tc.function?.arguments),
        });
      return { role: 'assistant', content, _source: i };
    }
    return {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: m.tool_call_id,
          toolName: names.get(m.tool_call_id) ?? 'tool',
          output: { type: 'text', value: contentText(m.content) },
        },
      ],
      _source: i,
    };
  });
}

/** ModelMessage[] -> the fixture's OpenAI shape; untouched messages come back as the originals. */
export function toOpenAI(modelMessages, original) {
  return modelMessages.map((mm) => {
    const src = original[mm._source];
    if (typeof mm.content === 'string') return src;
    const parts = mm.content;
    if (mm.role === 'assistant') {
      const text = parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('');
      const calls = parts.filter((p) => p.type === 'tool-call');
      if (calls.length === (src.tool_calls ?? []).length) return src;
      const out = { ...src, content: text };
      if (calls.length)
        out.tool_calls = src.tool_calls.filter((tc) => calls.some((c) => c.toolCallId === tc.id));
      else delete out.tool_calls;
      return out;
    }
    return src;
  });
}

const TOOLCALLS = process.env.BENCH_AI_SDK_TOOLCALLS ?? 'before-last-2-messages';

export default {
  name: `ai-sdk-prune:${TOOLCALLS}`,
  async run(input) {
    const messages = toOpenAIShape(input);
    const t0 = performance.now();
    const pruned = pruneMessages({
      messages: toModelMessages(messages),
      reasoning: 'before-last-message',
      toolCalls: TOOLCALLS,
      emptyMessages: 'remove',
    });
    return {
      output: toOpenAI(pruned, messages),
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: performance.now() - t0,
      costUsd: 0,
    };
  },
};
