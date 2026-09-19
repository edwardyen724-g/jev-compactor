// Shared LLM helpers for the product baselines. Two transports:
//   openrouter(model, messages, opts) — OpenAI-compatible chat completions on openrouter.ai with
//     `usage: { include: true }`, so `usage.cost` is the provider's own dollar figure (falls back to
//     the /api/v1/models price list when a response carries no cost).
//   anthropic(model, opts)            — the Messages API at list price ($2 / $10 per million for
//     claude-sonnet-5); accepts beta headers and the two compaction parameters.
// Both return { text, inputTokens, outputTokens, latencyMs, costUsd, raw } and never print a key.
// Keys come from .env.local through jev-compactor's loadEnvLocal (run.ts loads it too).
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvLocal } from 'jev-compactor';

loadEnvLocal(resolve(dirname(fileURLToPath(import.meta.url)), '..'));

/** USD per million tokens. Edit if Anthropic changes list prices. */
export const ANTHROPIC_PRICES = {
  'claude-sonnet-5': { input: 2, output: 10 },
};

/** The Claude model every Anthropic-side port uses when the upstream product's model is the user's. */
export const CLAUDE_MODEL = process.env.BENCH_CLAUDE_MODEL ?? 'claude-sonnet-5';

const OPENROUTER = 'https://openrouter.ai/api/v1';
let priceList;

async function openrouterPrice(model) {
  if (!priceList) {
    const res = await fetch(`${OPENROUTER}/models`);
    if (!res.ok) throw new Error(`openrouter /models HTTP ${res.status}`);
    const body = await res.json();
    priceList = new Map(body.data.map((m) => [m.id, m.pricing]));
  }
  const p = priceList.get(model);
  if (!p) throw new Error(`openrouter: no pricing for ${model}`);
  return { input: Number(p.prompt), output: Number(p.completion) };
}

/**
 * @param {string} model OpenRouter model id, e.g. 'x-ai/grok-4.6'
 * @param {object[]} messages OpenAI chat messages (system/user/assistant/tool)
 * @param {{ maxTokens?: number, tools?: object[], temperature?: number, reasoning?: object }} [opts]
 */
export async function openrouter(model, messages, opts = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set (baseline needs it)');
  const t0 = performance.now();
  const res = await fetch(`${OPENROUTER}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      'http-referer': 'https://github.com/edwardyen724-g/jev-compactor',
      'x-title': 'jev-compactor bench',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: opts.maxTokens ?? 4096,
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
      usage: { include: true },
    }),
  });
  const latencyMs = performance.now() - t0;
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error)
    throw new Error(
      `openrouter ${model} HTTP ${res.status}: ${body.error?.message ?? JSON.stringify(body).slice(0, 300)}`,
    );
  const choice = body.choices?.[0];
  const message = choice?.message ?? {};
  const text = typeof message.content === 'string' ? message.content : '';
  const inputTokens = body.usage?.prompt_tokens ?? 0;
  const outputTokens = body.usage?.completion_tokens ?? 0;
  let costUsd = typeof body.usage?.cost === 'number' ? body.usage.cost : undefined;
  if (costUsd === undefined) {
    const p = await openrouterPrice(model);
    costUsd = inputTokens * p.input + outputTokens * p.output;
  }
  return { text, inputTokens, outputTokens, latencyMs, costUsd, raw: body };
}

/**
 * @param {string} model e.g. 'claude-sonnet-5'
 * @param {{ system?: string, messages: object[], maxTokens?: number, betas?: string[],
 *           contextManagement?: object, compaction?: object, tools?: object[] }} opts
 */
export async function anthropic(model, opts) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set (baseline needs it)');
  const base = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const headers = {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  };
  if (opts.betas?.length) headers['anthropic-beta'] = opts.betas.join(',');
  const t0 = performance.now();
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 4096,
      ...(opts.system ? { system: opts.system } : {}),
      ...(opts.tools ? { tools: opts.tools } : {}),
      messages: opts.messages,
      ...(opts.contextManagement ? { context_management: opts.contextManagement } : {}),
      ...(opts.compaction ? { compaction: opts.compaction } : {}),
    }),
  });
  const latencyMs = performance.now() - t0;
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.type === 'error')
    throw new Error(
      `anthropic ${model} HTTP ${res.status}: ${body.error?.message ?? JSON.stringify(body).slice(0, 300)}`,
    );
  const text = (body.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const compaction = (body.content ?? []).find((b) => b.type === 'compaction');
  // With a compaction beta enabled the top-level usage excludes the compaction iteration; the
  // billed total is the sum over usage.iterations (docs: "Understanding usage").
  const iterations = body.usage?.iterations;
  let inputTokens = body.usage?.input_tokens ?? 0;
  let outputTokens = body.usage?.output_tokens ?? 0;
  if (Array.isArray(iterations) && iterations.length > 0) {
    inputTokens = iterations.reduce((s, it) => s + (it.input_tokens ?? 0), 0);
    outputTokens = iterations.reduce((s, it) => s + (it.output_tokens ?? 0), 0);
  }
  const price = ANTHROPIC_PRICES[model];
  if (!price) throw new Error(`no list price recorded for ${model}; add it to ANTHROPIC_PRICES`);
  const costUsd = (inputTokens * price.input + outputTokens * price.output) / 1e6;
  return {
    text,
    compaction,
    stopReason: body.stop_reason,
    inputTokens,
    outputTokens,
    latencyMs,
    costUsd,
    raw: body,
  };
}

/** Anthropic's token counter (free): the real input size of a converted transcript. */
export async function anthropicCountTokens(model, { system, messages, betas }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const base = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const headers = {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  };
  if (betas?.length) headers['anthropic-beta'] = betas.join(',');
  const res = await fetch(`${base}/v1/messages/count_tokens`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, ...(system ? { system } : {}), messages }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`count_tokens HTTP ${res.status}: ${body.error?.message ?? ''}`);
  return body.input_tokens;
}

// ───────────────────────── transcript shape helpers ─────────────────────────

/** The text of an OpenAI/plain message's content (string or text blocks). */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : ''))
      .join('');
  return content == null ? '' : String(content);
}

/**
 * Bring any transcript the bench loads into the OpenAI chat shape the ports are written for:
 * Anthropic content blocks (`tool_use` -> tool_calls, each `tool_result` block -> one tool message,
 * user text blocks -> a user message) and LangChain typed messages (`type: human|ai|tool|system`,
 * `tool_calls: [{id, name, args}]`). OpenAI / plain role-content transcripts are returned as the
 * same array (the caller's objects), so the products' "kept messages" stay identity-preserving.
 */
export function toOpenAIShape(messages) {
  const lcRole = { human: 'user', ai: 'assistant', tool: 'tool', system: 'system' };
  const out = [];
  let changed = false;
  for (const m of messages) {
    if (!m.role && m.type && lcRole[m.type]) {
      changed = true;
      const role = lcRole[m.type];
      const text = contentText(m.content);
      if (role === 'assistant') {
        const tcs = (m.tool_calls ?? []).map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
        }));
        out.push({ role, content: text, ...(tcs.length ? { tool_calls: tcs } : {}) });
      } else if (role === 'tool') out.push({ role, content: text, tool_call_id: m.tool_call_id });
      else out.push({ role, content: text });
      continue;
    }
    if (
      Array.isArray(m.content) &&
      m.content.some((b) => b?.type === 'tool_use' || b?.type === 'tool_result')
    ) {
      changed = true;
      const text = m.content
        .filter((b) => b?.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      if (m.role === 'assistant') {
        const tcs = m.content
          .filter((b) => b?.type === 'tool_use')
          .map((b) => ({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          }));
        out.push({ role: 'assistant', content: text, ...(tcs.length ? { tool_calls: tcs } : {}) });
      } else {
        for (const b of m.content)
          if (b?.type === 'tool_result')
            out.push({
              role: 'tool',
              content: contentText(b.content),
              tool_call_id: b.tool_use_id,
            });
        if (text) out.push({ role: 'user', content: text });
      }
      continue;
    }
    out.push(m);
  }
  return changed ? out : messages;
}

/** Parse an OpenAI tool-call's JSON arguments, falling back to the raw string. */
export function parseArgs(args) {
  if (typeof args !== 'string') return args ?? {};
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

/**
 * Convert an OpenAI-format transcript (system / user / assistant+tool_calls / tool) into an
 * Anthropic Messages request: the system message(s) become `system`, tool calls become
 * `tool_use` blocks, tool messages become `tool_result` blocks in a user turn, and consecutive
 * same-role turns are merged so the request is valid. Tool definitions are recovered from the
 * transcript's tool names with a permissive schema so the summarizer can read the calls.
 */
export function toAnthropic(messages) {
  const systems = [];
  const out = [];
  const toolNames = new Set();
  const push = (role, blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const m of messages) {
    if (m.role === 'system') {
      systems.push(contentText(m.content));
    } else if (m.role === 'user') {
      const text = contentText(m.content);
      push('user', [{ type: 'text', text: text || '(empty)' }]);
    } else if (m.role === 'assistant') {
      const blocks = [];
      const text = contentText(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const tc of m.tool_calls ?? []) {
        toolNames.add(tc.function?.name ?? 'tool');
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function?.name ?? 'tool',
          input: parseArgs(tc.function?.arguments),
        });
      }
      if (blocks.length === 0) blocks.push({ type: 'text', text: '(empty)' });
      push('assistant', blocks);
    } else if (m.role === 'tool') {
      push('user', [
        { type: 'tool_result', tool_use_id: m.tool_call_id, content: contentText(m.content) },
      ]);
    }
  }
  // Anthropic requires the conversation to start with a user turn.
  if (out.length > 0 && out[0].role !== 'user')
    out.unshift({ role: 'user', content: [{ type: 'text', text: '(conversation start)' }] });
  const tools = [...toolNames].map((name) => ({
    name,
    description: `The ${name} tool as used in this transcript.`,
    input_schema: { type: 'object', additionalProperties: true },
  }));
  return { system: systems.join('\n\n') || undefined, messages: out, tools };
}

/**
 * OpenAI-compatible providers on OpenRouter expect a `tools` list when the history contains tool
 * calls; recover one from the transcript's tool names with a permissive schema.
 */
export function openaiToolStubs(messages) {
  const names = new Set();
  for (const m of messages) for (const tc of m.tool_calls ?? []) names.add(tc.function?.name);
  return [...names].filter(Boolean).map((name) => ({
    type: 'function',
    function: {
      name,
      description: `The ${name} tool as used in this transcript.`,
      parameters: { type: 'object', additionalProperties: true },
    },
  }));
}

/** Text between the first <tag> and the last </tag>, or the whole text when the tags are absent. */
export function between(text, tag) {
  const start = text.indexOf(`<${tag}>`);
  const end = text.lastIndexOf(`</${tag}>`);
  if (start === -1 || end === -1 || end <= start) return text.trim();
  return text.slice(start + tag.length + 2, end).trim();
}
