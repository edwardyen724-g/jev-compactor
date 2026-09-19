/**
 * Adapters: turn OpenAI / Anthropic / LangChain / plain chat messages into `Frame`s, group tool
 * calls with their results into `Unit`s, and derive the default goal. The caller's objects are
 * only read, never mutated, and are referenced by `index`.
 */
import { createHash } from 'node:crypto';
import { messageTokens } from './tokens.js';
import type { AnyMessage, Frame, FrameKind, MessageFormat, Role, Unit } from './types.js';

// ───────────────────────────── format detection ─────────────────────────────

const LANGCHAIN_TYPES: Readonly<Record<string, Role>> = {
  human: 'user',
  ai: 'assistant',
  system: 'system',
  tool: 'tool',
  function: 'tool',
};

const ROLE_ALIASES: Readonly<Record<string, Role>> = {
  system: 'system',
  developer: 'system',
  user: 'user',
  human: 'user',
  assistant: 'assistant',
  ai: 'assistant',
  model: 'assistant',
  tool: 'tool',
  function: 'tool',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function blockType(block: unknown): string | undefined {
  if (!isRecord(block)) return undefined;
  return typeof block.type === 'string' ? block.type : undefined;
}

function hasAnthropicBlocks(m: Record<string, unknown>): boolean {
  const content = m.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const type = blockType(block);
    return type === 'tool_use' || type === 'tool_result';
  });
}

function hasOpenAiMarkers(m: Record<string, unknown>): boolean {
  return (
    m.tool_calls !== undefined ||
    m.tool_call_id !== undefined ||
    m.role === 'tool' ||
    // Legacy function calling (`function_call` + `role: 'function'`), still emitted by older loops.
    m.function_call !== undefined ||
    m.role === 'function'
  );
}

/** LangChain `type`, read from the plain field or from a class instance's `_getType()`/`getType()`. */
function langchainType(m: Record<string, unknown>): string | undefined {
  if (typeof m.type === 'string' && m.type in LANGCHAIN_TYPES) return m.type;
  for (const method of ['_getType', 'getType'] as const) {
    const fn = m[method];
    if (typeof fn === 'function') {
      try {
        const result: unknown = (fn as () => unknown).call(m);
        if (typeof result === 'string') return result;
      } catch {
        // A throwing getter is treated as absent.
      }
    }
  }
  return undefined;
}

function hasLangchainMarkers(m: Record<string, unknown>): boolean {
  return (
    langchainType(m) !== undefined ||
    typeof m._getType === 'function' ||
    typeof m.getType === 'function' ||
    m.lc_kwargs !== undefined
  );
}

/**
 * anthropic: any `content` array with a `tool_use`/`tool_result` block; openai: any `tool_calls`,
 * `tool_call_id`, `role:'tool'`, or the legacy `function_call`/`role:'function'` pair on a message
 * that carries no LangChain marker; langchain: any
 * LangChain `type`, `_getType`/`getType` method or `lc_kwargs`; otherwise plain. Precedence:
 * anthropic, then openai, then langchain.
 */
export function detectFormat(messages: AnyMessage[]): MessageFormat {
  const records = messages.map(asRecord);
  if (records.some(hasAnthropicBlocks)) return 'anthropic';
  if (records.some((m) => hasOpenAiMarkers(m) && !hasLangchainMarkers(m))) return 'openai';
  if (records.some(hasLangchainMarkers)) return 'langchain';
  return 'plain';
}

// ───────────────────────────── text flattening ─────────────────────────────

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
        continue;
      }
      if (!isRecord(block)) continue;
      const type = blockType(block);
      if ((type === 'text' || type === undefined) && typeof block.text === 'string') {
        parts.push(block.text);
      } else if (type === 'tool_use') {
        parts.push(
          `[tool_use ${String(block.name ?? '')} ${String(block.id ?? '')}] ${JSON.stringify(block.input) ?? ''}`,
        );
      } else if (type === 'tool_result') {
        parts.push(
          `[tool_result ${String(block.tool_use_id ?? '')}] ${textOfContent(block.content)}`,
        );
      } else {
        parts.push(`[${type ?? 'unknown'}]`);
      }
    }
    return parts.join('\n');
  }
  if (content === null || content === undefined) return '';
  if (isRecord(content) && typeof content.text === 'string') return content.text;
  return String(content);
}

interface ToolCallInfo {
  ids: string[];
  names: string[];
  lines: string[];
}

/**
 * Legacy OpenAI function calling carries no call id: the `function_call` and the `role: 'function'`
 * result are paired by function name through this synthetic id, so they still form one unit.
 */
function legacyCallId(name: string): string {
  return `function:${name}`;
}

/**
 * OpenAI `tool_calls[i].function.{name,arguments}`, LangChain `tool_calls[i].{name,args}`, or the
 * legacy OpenAI `function_call.{name,arguments}` (one call, paired by name via `legacyCallId`).
 */
function readToolCalls(m: Record<string, unknown>): ToolCallInfo {
  const info: ToolCallInfo = { ids: [], names: [], lines: [] };
  const legacy = m.function_call;
  if (isRecord(legacy) && typeof legacy.name === 'string' && legacy.name !== '') {
    const a = legacy.arguments;
    const args = typeof a === 'string' ? a : (JSON.stringify(a) ?? '');
    const id = legacyCallId(legacy.name);
    info.ids.push(id);
    info.names.push(legacy.name);
    info.lines.push(`[tool_call ${legacy.name} ${id}] ${args}`);
  }
  if (!Array.isArray(m.tool_calls)) return info;
  for (const raw of m.tool_calls) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.id === 'string' ? raw.id : '';
    let name: string;
    let args: string;
    if (isRecord(raw.function)) {
      name = typeof raw.function.name === 'string' ? raw.function.name : '';
      const a = raw.function.arguments;
      args = typeof a === 'string' ? a : (JSON.stringify(a) ?? '');
    } else {
      name = typeof raw.name === 'string' ? raw.name : '';
      args = JSON.stringify(raw.args) ?? '';
    }
    if (id) info.ids.push(id);
    if (name) info.names.push(name);
    info.lines.push(`[tool_call ${name} ${id}] ${args}`);
  }
  return info;
}

// ───────────────────────────── heuristics ─────────────────────────────

const PATH_LIKE_RE = /(?:[\w@.-]+\/)+[\w.-]+/g;
const FILE_NAME_RE =
  /\b[\w-]+\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|json|ya?ml|toml|md|sql|env|txt|css|html)\b/g;
const URL_RE = /https?:\/\/\S+/g;
const MIN_PATH_CHARS = 4;

function extractPaths(text: string): string[] {
  const found = new Set<string>();
  for (const re of [PATH_LIKE_RE, FILE_NAME_RE, URL_RE]) {
    for (const match of text.matchAll(re)) {
      if (match[0].length >= MIN_PATH_CHARS) found.add(match[0]);
    }
  }
  return [...found];
}

const FENCE_RE = /```/;
// A line may also start after a JSON-escaped newline (`\n` as two characters): tool-call frames
// render their arguments as JSON, so a diff passed to an `apply_patch`-style tool arrives escaped.
const DIFF_HEADER_RE = /(?:^|\\n)(\+\+\+ |--- |@@ )/m;
const DIFF_LINE_RE = /(?:^|\\n)[+-](?![+-])/gm;

/** Fenced code block, a unified-diff header, or at least three `+`/`-` changed lines. */
function detectCode(text: string): boolean {
  if (FENCE_RE.test(text) || DIFF_HEADER_RE.test(text)) return true;
  let changedLines = 0;
  for (const _ of text.matchAll(DIFF_LINE_RE)) {
    if (++changedLines >= 3) return true;
  }
  return false;
}

function hashOf(role: Role, text: string): string {
  return createHash('sha1').update(`${role}\0${text}`).digest('hex');
}

// ───────────────────────────── normalize ─────────────────────────────

function resolveRole(m: Record<string, unknown>, format: MessageFormat): Role {
  const lcType = langchainType(m);
  if (format === 'langchain' && lcType !== undefined) {
    const mapped = LANGCHAIN_TYPES[lcType];
    if (mapped) return mapped;
  }
  if (typeof m.role === 'string') {
    const mapped = ROLE_ALIASES[m.role];
    if (mapped) return mapped;
  }
  if (lcType !== undefined) {
    const mapped = LANGCHAIN_TYPES[lcType];
    if (mapped) return mapped;
  }
  return 'user';
}

function toFrame(
  m: Record<string, unknown>,
  original: AnyMessage,
  index: number,
  format: MessageFormat,
  pin: ((index: number, m: AnyMessage) => boolean) | undefined,
): Frame {
  const role = resolveRole(m, format);
  const content = m.content;
  const blocks = Array.isArray(content) ? content : [];
  const calls = readToolCalls(m);

  const toolCallIds: string[] = [...calls.ids];
  const toolNames: string[] = [...calls.names];
  let issuesCalls = calls.ids.length > 0 || calls.lines.length > 0;
  let hasToolResultBlock = false;
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    const type = blockType(block);
    if (type === 'tool_use') {
      issuesCalls = true;
      if (typeof block.id === 'string') toolCallIds.push(block.id);
      if (typeof block.name === 'string') toolNames.push(block.name);
    } else if (type === 'tool_result') {
      hasToolResultBlock = true;
      if (typeof block.tool_use_id === 'string') toolCallIds.push(block.tool_use_id);
    }
  }
  if (typeof m.tool_call_id === 'string') toolCallIds.push(m.tool_call_id);
  if (role === 'tool' && typeof m.name === 'string' && m.name !== '') {
    toolNames.push(m.name);
    // A legacy `role: 'function'` result answers the `function_call` of the same name.
    if (m.role === 'function' && typeof m.tool_call_id !== 'string') {
      toolCallIds.push(legacyCallId(m.name));
    }
  }

  let kind: FrameKind;
  if (role === 'system') kind = 'system';
  else if (role === 'tool') kind = 'tool_result';
  else if (role === 'assistant' && issuesCalls) kind = 'tool_call';
  else if (role === 'user' && hasToolResultBlock) kind = 'tool_result';
  else kind = role;

  const contentText = textOfContent(content);
  const text =
    calls.lines.length === 0
      ? contentText
      : [...(contentText === '' ? [] : [contentText]), ...calls.lines].join('\n');

  return {
    index,
    role,
    kind,
    text,
    chars: text.length,
    tokens: messageTokens(original),
    paths: extractPaths(text),
    hasCode: detectCode(text),
    toolCallIds: [...new Set(toolCallIds)],
    toolNames,
    hash: hashOf(role, text),
    pinned: m.pin === true || pin?.(index, original) === true,
  };
}

/**
 * Normalizes every message into a `Frame`. `format: 'auto'` runs `detectFormat`. The messages are
 * never mutated; each frame carries the original's `index`.
 */
export function normalize(
  messages: AnyMessage[],
  format: MessageFormat | 'auto',
  pin?: (index: number, m: AnyMessage) => boolean,
): { format: MessageFormat; frames: Frame[] } {
  const resolved: MessageFormat = format === 'auto' ? detectFormat(messages) : format;
  const frames = messages.map((original, index) =>
    toFrame(asRecord(original), original, index, resolved, pin),
  );
  return { format: resolved, frames };
}

// ───────────────────────────── units ─────────────────────────────

function makeUnit(position: number, frames: Frame[]): Unit {
  let tokens = 0;
  let isTool = false;
  for (const f of frames) {
    tokens += f.tokens;
    if (f.kind === 'tool_call' || f.kind === 'tool_result') isTool = true;
  }
  return {
    id: `u${position}`,
    frames,
    indices: frames.map((f) => f.index),
    tokens,
    text: frames.map((f) => f.text).join('\n'),
    isTool,
  };
}

/**
 * A `tool_call` frame absorbs every following `tool_result` frame whose `toolCallIds` intersect
 * its own, scanning until the first frame that is not a `tool_result` (results may only be
 * interleaved with other results). A `tool_result` nobody absorbed is a unit of its own.
 */
export function groupUnits(frames: Frame[]): Unit[] {
  const units: Unit[] = [];
  const consumed: boolean[] = new Array<boolean>(frames.length).fill(false);
  for (let i = 0; i < frames.length; i++) {
    const head = frames[i];
    if (head === undefined || consumed[i]) continue;
    consumed[i] = true;
    const group: Frame[] = [head];
    if (head.kind === 'tool_call' && head.toolCallIds.length > 0) {
      const ids = new Set(head.toolCallIds);
      for (let j = i + 1; j < frames.length; j++) {
        const next = frames[j];
        if (next === undefined || next.kind !== 'tool_result') break;
        if (consumed[j]) continue;
        if (next.toolCallIds.some((id) => ids.has(id))) {
          group.push(next);
          consumed[j] = true;
        }
      }
    }
    units.push(makeUnit(units.length, group));
  }
  return units;
}

/**
 * The agent's pending action: the newest unit that is not a system message, when the agent authored
 * it — an assistant message, or a tool call together with its results. `undefined` when the newest
 * unit is the user's (a question, or the rejection of a proposal) or an orphan tool result: then
 * nothing the agent did is awaiting the next model call. Safety gating blocks on this unit only;
 * findings about older units are reported and flagged but do not block.
 */
export function pendingUnit(units: readonly Unit[]): Unit | undefined {
  for (let i = units.length - 1; i >= 0; i--) {
    const unit = units[i];
    const first = unit?.frames[0];
    if (unit === undefined || first === undefined || first.kind === 'system') continue;
    return first.role === 'assistant' ? unit : undefined;
  }
  return undefined;
}

/**
 * The message indices of a unit's agent-authored frames — its assistant text and tool calls: what
 * the agent proposed or did. Tool results are what came back and are excluded, so a command that a
 * result merely quotes (a README the agent read) never counts as the agent's action.
 */
export function actionIndices(unit: Unit): number[] {
  return unit.frames.filter((f) => f.role === 'assistant').map((f) => f.index);
}

// ───────────────────────────── goal ─────────────────────────────

const GOAL_MAX_CHARS = 500;

/** Text of the last `user` frame (kind `user`, so tool results never count), ≤ 500 chars, else ''. */
export function defaultGoal(frames: Frame[]): string {
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i];
    if (frame !== undefined && frame.kind === 'user') return frame.text.slice(0, GOAL_MAX_CHARS);
  }
  return '';
}
