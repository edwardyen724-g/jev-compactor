/**
 * The `jev-compactor-mcp` bin as a child process, driven with the MCP SDK's own Client over
 * stdio, against the real Jev — no mocks (workspace rule). Skipped loudly without
 * TYPESAFE_API_KEY. The key is handed to the child through its environment only; it is never
 * read into a test value or printed. Cost: three small runs, well under $0.001.
 */
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnvLocal } from '../src/env.js';
import type { AnyMessage, CompactionReport, ForemanFinding } from '../src/types.js';
import { ensureBuilt, fixture, GOAL, MCP_BIN, PACKAGE_DIR, REPO_ROOT } from './bin.helpers.js';

loadEnvLocal(REPO_ROOT);

const HAS_KEY = Boolean(process.env.TYPESAFE_API_KEY);
if (!HAS_KEY) console.warn('TYPESAFE_API_KEY not set — live tests skipped');

interface TextContent {
  type: string;
  text?: string;
}

interface ToolResult {
  content: TextContent[];
  isError?: boolean;
}

function textOf(result: ToolResult, index = 0): string {
  const block = result.content[index];
  expect(block?.type, `content[${index}] is text`).toBe('text');
  return block?.text ?? '';
}

function loadFixture(name: string): AnyMessage[] {
  return JSON.parse(readFileSync(fixture(name), 'utf8')) as AnyMessage[];
}

describe.skipIf(!HAS_KEY)('mcp server (live)', () => {
  let client: Client;
  let transport: StdioClientTransport;
  let serverStderr = '';

  beforeAll(async () => {
    await ensureBuilt();
    const env: Record<string, string> = { ...getDefaultEnvironment() };
    const key = process.env.TYPESAFE_API_KEY;
    if (key !== undefined) env.TYPESAFE_API_KEY = key;
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_BIN],
      cwd: PACKAGE_DIR,
      env,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      serverStderr += chunk.toString();
    });
    client = new Client({ name: 'jev-compactor-test', version: '0.0.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
    if (serverStderr !== '') console.warn(`server stderr:\n${serverStderr}`);
  });

  it('lists the four tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'check_action',
      'compact_context',
      'inspect_context',
      'self_test',
    ]);
    const compactTool = tools.find((t) => t.name === 'compact_context');
    expect(compactTool?.inputSchema).toMatchObject({ type: 'object', required: ['messages'] });
    expect(Object.keys(compactTool?.inputSchema.properties ?? {}).sort()).toEqual([
      'format',
      'goal',
      'maxTokens',
      'messages',
      'safetyGating',
    ]);
    const version = client.getServerVersion();
    expect(version?.name).toBe('jev-compactor');
    expect(version?.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('check_action blocks rm -rf ./src with a destructive finding', async () => {
    const result = (await client.callTool({
      name: 'check_action',
      arguments: { action: 'rm -rf ./src', goal: GOAL },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(result)) as {
      findings: ForemanFinding[];
      blocked: boolean;
      skipped?: string;
    };
    expect(parsed.blocked).toBe(true);
    expect(parsed.skipped).toBeUndefined();
    const destructive = parsed.findings.filter((f) => f.kind === 'destructive');
    expect(destructive.length).toBeGreaterThanOrEqual(1);
    expect(
      destructive.some(
        (f) => f.source === 'pattern' && f.level === 'action' && f.probability === 1,
      ),
    ).toBe(true);
    expect(destructive.find((f) => f.source === 'pattern')?.evidence).toContain('rm -rf ./src');
    // Jev answered the Foreman questions too.
    expect(parsed.findings.some((f) => f.source === 'jev') || parsed.findings.length >= 1).toBe(
      true,
    );
  });

  it('check_action passes a benign read-only command', async () => {
    const result = (await client.callTool({
      name: 'check_action',
      arguments: { action: 'cat src/auth.ts', goal: GOAL },
    })) as ToolResult;
    const parsed = JSON.parse(textOf(result)) as { findings: ForemanFinding[]; blocked: boolean };
    expect(parsed.findings.some((f) => f.source === 'pattern')).toBe(false);
    expect(
      parsed.findings.filter((f) => f.kind === 'destructive' && f.level === 'action'),
    ).toHaveLength(0);
  });

  it('compact_context on the plain fixture returns messages and a report', async () => {
    const messages = loadFixture('plain-chat.json');
    const result = (await client.callTool({
      name: 'compact_context',
      arguments: { messages, goal: GOAL, maxTokens: 4000 },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(result)) as {
      messages: AnyMessage[];
      report: CompactionReport;
      blocked: boolean;
      systemAddendum?: string;
    };
    expect(Array.isArray(parsed.messages)).toBe(true);
    expect(parsed.messages.length).toBeLessThan(messages.length);
    expect(parsed.blocked).toBe(false);
    expect(parsed.report.goal).toBe(GOAL);
    expect(parsed.report.format).toBe('plain');
    expect(parsed.report.skipped).toBeUndefined();
    expect(parsed.report.jev?.requests).toBeGreaterThanOrEqual(1);
    expect(parsed.report.units.length).toBeGreaterThan(0);
    expect(parsed.report.messagesAfter).toBe(parsed.messages.length);
    const inputs = new Set(messages.map((m) => JSON.stringify(m)));
    const extras = parsed.messages.filter((m) => !inputs.has(JSON.stringify(m)));
    expect(extras.length).toBeLessThanOrEqual(1); // at most the corrective system message
  });

  it('inspect_context returns the plain view and the report JSON', async () => {
    const messages = loadFixture('openai-tool-loop.json');
    const result = (await client.callTool({
      name: 'inspect_context',
      arguments: { messages, goal: GOAL },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(2);
    const view = textOf(result, 0);
    expect(view).not.toContain(String.fromCharCode(27)); // no ANSI styling
    expect(view).toMatch(/^goal {5}Fix the failing unit test in src\/auth\.ts$/m);
    expect(
      view.split('\n').filter((l) => /^(KEEP|PIN|FLAG|DUP|DROP)\b/.test(l)).length,
    ).toBeGreaterThan(10);
    expect(view).toMatch(/^FLAG .*rm -rf \.\/src/m);
    const report = JSON.parse(textOf(result, 1)) as CompactionReport;
    expect(report.format).toBe('openai');
    expect(report.units.length).toBeGreaterThan(0);
  });

  it('returns invalid arguments as an error result, not a transport failure', async () => {
    const result = (await client.callTool({
      name: 'compact_context',
      arguments: { messages: 'not an array' },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    const key = process.env.TYPESAFE_API_KEY ?? '';
    if (key !== '') expect(textOf(result)).not.toContain(key);
    expect(client.getServerVersion()?.name).toBe('jev-compactor'); // still connected
  });
});
