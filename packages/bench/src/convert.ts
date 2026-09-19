/**
 * Transcript loaders. Every loader returns a plain message array that jev-compactor's `normalize`
 * can detect on its own (Anthropic content blocks, OpenAI tool_calls, or plain role/content).
 * Nothing here is ever printed; transcripts may contain private code.
 */
import type { AnyMessage } from 'jev-compactor';

export interface Transcript {
  name: string;
  source: 'claude-code-jsonl' | 'fast-jev' | 'messages-json';
  messages: AnyMessage[];
}

/** Claude Code session log: one JSON object per line; `user`/`assistant` lines carry `message: {role, content}`. */
export function fromClaudeCodeJsonl(text: string): AnyMessage[] {
  const out: AnyMessage[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(o)) continue;
    const m = o.message;
    if ((o.type === 'user' || o.type === 'assistant') && isRecord(m)) {
      const role = m.role;
      if (role === 'user' || role === 'assistant') out.push({ role, content: m.content ?? '' });
    }
  }
  return out;
}

/** The `Message` shape used by tamaratran/fast-jev-compaction (a subset of Claude Code's SessionMessage). */
export interface FastJevMessage {
  role: 'user' | 'assistant';
  text: string;
  toolUses?: { tool_use_id: string; tool: string; input: unknown }[];
  toolResults?: { tool_use_id: string; text: string }[];
}

export function fromFastJev(messages: FastJevMessage[]): AnyMessage[] {
  return messages.map((m) => {
    const content: Record<string, unknown>[] = [];
    if (m.text) content.push({ type: 'text', text: m.text });
    for (const r of m.toolResults ?? [])
      content.push({ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.text });
    for (const u of m.toolUses ?? [])
      content.push({ type: 'tool_use', id: u.tool_use_id, name: u.tool, input: u.input });
    return {
      role: m.role,
      content: content.length === 1 && content[0]?.type === 'text' ? m.text : content,
    };
  });
}

/** Pick a loader from the file name and shape. */
export function loadTranscript(name: string, raw: string): Transcript {
  if (name.endsWith('.jsonl'))
    return { name, source: 'claude-code-jsonl', messages: fromClaudeCodeJsonl(raw) };
  const parsed: unknown = JSON.parse(raw);
  const arr = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.messages)
      ? parsed.messages
      : null;
  if (!arr) throw new Error(`${name}: expected a JSON array or {messages: [...]}`);
  if (arr.some((m) => isRecord(m) && ('toolUses' in m || 'toolResults' in m)))
    return { name, source: 'fast-jev', messages: fromFastJev(arr as FastJevMessage[]) };
  return { name, source: 'messages-json', messages: arr as AnyMessage[] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
