/**
 * `jev-compactor-mcp`: an MCP server over stdio exposing `compact_context`, `inspect_context` and
 * `check_action`. Every tool runs the same `compact()` pipeline as the library; every failure comes
 * back as an `isError` result (never thrown, never with the API key in it). Only protocol bytes go
 * to stdout; diagnostics go to stderr.
 *
 * The bin is the bundled `dist/mcp.mjs` (tsdown adds the shebang); this module runs `main()` at
 * load — connecting a stdio transport — so nothing else imports it; `createServer()` is exported for
 * the tests only, not as an embedding API.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { compact } from './engine.js';
import { loadEnvLocal } from './env.js';
import { describeError, packageVersion, redact, redactReport, renderInspect } from './render.js';
import type { AnyMessage, CompactOptions } from './types.js';

export const SERVER_NAME = 'jev-compactor';

const MessagesSchema = z
  .array(z.record(z.string(), z.unknown()))
  .describe(
    'The chat history: an array of OpenAI, Anthropic, LangChain or plain {role, content} message objects, oldest first.',
  );
const GoalSchema = z
  .string()
  .describe("The agent's active goal. Default: the text of the last user message.");
const FormatSchema = z
  .enum(['auto', 'openai', 'anthropic', 'langchain', 'plain'])
  .describe('Force the message adapter. Default: auto-detect.');

// ───────────────────────────── results ─────────────────────────────

function textResult(...texts: string[]): CallToolResult {
  return { content: texts.map((text) => ({ type: 'text', text })) };
}

function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

function errorResult(error: unknown): CallToolResult {
  return { content: [{ type: 'text', text: `error: ${describeError(error)}` }], isError: true };
}

/** Runs a tool body; anything thrown becomes an `isError` result. */
async function guarded(body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await body();
  } catch (error: unknown) {
    return errorResult(error);
  }
}

// ───────────────────────────── server ─────────────────────────────

/** Builds the server with its three tools registered; the caller connects a transport. */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: packageVersion() });

  server.registerTool(
    'compact_context',
    {
      title: 'Compact context',
      description:
        'Compacts an agent chat history for a goal. Returns the kept messages verbatim (never rewritten, tool calls and results kept together), a per-message report with reasons and probabilities, Foreman safety findings, and `blocked` when safetyGating is on and an action-level finding exists. Jev judges relevance; pins, dedup and the token budget are deterministic.',
      inputSchema: {
        messages: MessagesSchema,
        goal: GoalSchema.optional(),
        maxTokens: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Token budget in estimated tokens. Default 15000.'),
        safetyGating: z
          .boolean()
          .optional()
          .describe(
            'Run the Foreman gate and honor `blocked`. Default false (findings still reported).',
          ),
        format: FormatSchema.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ messages, goal, maxTokens, safetyGating, format }) =>
      guarded(async () => {
        const options: CompactOptions = {};
        if (goal !== undefined) options.goal = goal;
        if (maxTokens !== undefined) options.maxTokens = maxTokens;
        if (safetyGating !== undefined) options.safetyGating = safetyGating;
        if (format !== undefined) options.format = format;
        const result = await compact(messages, options);
        const out: Record<string, unknown> = {
          messages: result.messages,
          report: redactReport(result.report),
          blocked: result.blocked,
        };
        if (result.systemAddendum !== undefined) out.systemAddendum = result.systemAddendum;
        return jsonResult(out);
      }),
  );

  server.registerTool(
    'inspect_context',
    {
      title: 'Inspect context',
      description:
        'Shows what compaction would do to a chat history without applying it: one line per unit (KEEP, PIN, FLAG, DUP, DROP with P(drop)), the Foreman findings and the corrective prompt, followed by the full report as JSON.',
      inputSchema: { messages: MessagesSchema, goal: GoalSchema.optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ messages, goal }) =>
      guarded(async () => {
        const options: CompactOptions = {};
        if (goal !== undefined) options.goal = goal;
        const result = await compact(messages, options);
        const view = renderInspect(result, messages, { color: false });
        return textResult(view, JSON.stringify(redactReport(result.report), null, 2));
      }),
  );

  server.registerTool(
    'check_action',
    {
      title: 'Check action',
      description:
        "Runs only the Foreman over a proposed action (a shell command, a tool call, a plan step): the regex floor for destructive and exfiltrating commands plus Jev's destructive / exfiltration / thrashing / goal-drift questions. Returns the findings and `blocked` (true when any finding is at action level).",
      inputSchema: {
        action: z.string().describe('The proposed action, e.g. a shell command or a tool call.'),
        goal: GoalSchema.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ action, goal }) =>
      guarded(async () => {
        const message: AnyMessage = { role: 'assistant', content: action };
        const options: CompactOptions = { safetyGating: true, keepRecent: 0 };
        if (goal !== undefined) options.goal = goal;
        const result = await compact([message], options);
        const out: Record<string, unknown> = {
          findings: result.report.foreman,
          blocked: result.blocked,
        };
        // A fail-open verdict came from the regex floor alone; say so rather than pass it off as Jev's.
        if (result.report.skipped !== undefined) out.skipped = result.report.skipped;
        if (result.report.error !== undefined) out.error = redact(result.report.error);
        return jsonResult(out);
      }),
  );

  return server;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`jev-compactor-mcp: ${describeError(error)}\n`);
  process.exitCode = 1;
});
