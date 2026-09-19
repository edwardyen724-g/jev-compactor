/**
 * `jev-compactor` CLI. `compact <file>` writes the compacted message array (the caller's original
 * objects, JSON) to stdout or `--out` with a one-line summary on stderr; `inspect <file>` renders
 * every unit's decision, the Foreman findings and the corrective prompt; `doctor` checks the key,
 * the Jev API and one end-to-end compaction. Exit 0, 2 when the run is blocked by safety gating,
 * 1 on any error (or a failed doctor check) with a message that never contains the API key.
 *
 * The bin is the bundled `dist/cli.mjs` (tsdown adds the shebang); this module runs `main()` at
 * load, so nothing else imports it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { compact, resolveOptions, selfTest } from './engine.js';
import { loadEnvLocal } from './env.js';
import { createClient } from './jev.js';
import {
  describeError,
  packageVersion,
  redact,
  redactResult,
  renderInspect,
  summaryLine,
} from './render.js';
import type { AnyMessage, CompactionResult, CompactOptions, MessageFormat } from './types.js';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_BLOCKED = 2;

const COMMANDS = ['compact', 'inspect', 'doctor'] as const;
type Command = (typeof COMMANDS)[number];

const FORMATS: ReadonlySet<string> = new Set(['auto', 'openai', 'anthropic', 'langchain', 'plain']);

export const USAGE = `Usage:
  jev-compactor compact <file> [options]   write the compacted messages (JSON) to stdout or --out
  jev-compactor inspect <file> [options]   show every unit's decision, the Foreman findings and the corrective prompt
  jev-compactor doctor                     check the API key, the Jev API and one end-to-end compaction

  <file> is a JSON array of messages or {"messages": [...]}; "-" reads stdin.

Options:
  --goal <text>        the agent's goal (default: the last user message)
  --max-tokens <n>     token budget in estimated tokens (default 15000)
  --format <f>         auto | openai | anthropic | langchain | plain (default auto)
  --safety             run the Foreman gate; exit 2 when an action-level finding blocks
  --json               print the full CompactionResult instead
  --out <file>         write the output to <file> instead of stdout
  -h, --help           show this help
  -v, --version        print the version

Exit codes: 0 ok, 1 error, 2 blocked (with --safety).
The API key is read from TYPESAFE_API_KEY or the nearest .env.local / .env.
`;

const OPTIONS = {
  goal: { type: 'string' },
  'max-tokens': { type: 'string' },
  format: { type: 'string' },
  safety: { type: 'boolean' },
  json: { type: 'boolean' },
  out: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

/** An error the CLI reports as a one-line message; `usage` also prints the help text. */
export class CliError extends Error {
  override name = 'CliError';
  constructor(
    message: string,
    public readonly usage = false,
  ) {
    super(message);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

// ───────────────────────────── input ─────────────────────────────

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readInput(file: string): Promise<string> {
  if (file === '-') return readStdin();
  try {
    return readFileSync(resolve(file), 'utf8');
  } catch (error: unknown) {
    throw new CliError(`cannot read ${file}: ${describeError(error)}`);
  }
}

/** A JSON array of message objects, or `{messages: [...]}`. */
export function parseMessages(text: string, source: string): AnyMessage[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error: unknown) {
    throw new CliError(`${source}: invalid JSON (${describeError(error)})`);
  }
  const list: unknown = Array.isArray(data) ? data : isObject(data) ? data.messages : undefined;
  if (!Array.isArray(list)) {
    throw new CliError(`${source}: expected a JSON array of messages or {"messages": [...]}`);
  }
  list.forEach((message, index) => {
    if (!isObject(message)) throw new CliError(`${source}: messages[${index}] is not an object`);
  });
  return list as AnyMessage[];
}

function parseMaxTokens(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number.parseInt(raw, 10) <= 0) {
    throw new CliError(`--max-tokens expects a positive integer, got '${raw}'`);
  }
  return Number.parseInt(raw, 10);
}

function parseFormat(raw: string | undefined): MessageFormat | 'auto' | undefined {
  if (raw === undefined) return undefined;
  if (!FORMATS.has(raw)) {
    throw new CliError(`--format expects one of ${[...FORMATS].join(', ')}, got '${raw}'`);
  }
  return raw as MessageFormat | 'auto';
}

// ───────────────────────────── output ─────────────────────────────

/** FORCE_COLOR wins, then NO_COLOR, then whether stdout is a terminal (Node's own precedence). */
function wantColor(): boolean {
  const force = process.env.FORCE_COLOR;
  if (force !== undefined) return force !== '0' && force.toLowerCase() !== 'false';
  const noColor = process.env.NO_COLOR;
  if (noColor !== undefined && noColor !== '') return false;
  return process.stdout.isTTY === true;
}

function writeOutput(text: string, out: string | undefined): void {
  if (out === undefined) {
    process.stdout.write(text);
    return;
  }
  try {
    writeFileSync(resolve(out), text);
  } catch (error: unknown) {
    throw new CliError(`cannot write ${out}: ${describeError(error)}`);
  }
}

function jsonOf(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ───────────────────────────── run ─────────────────────────────

/** Runs the CLI with `argv` (without the node and script paths) and returns the exit code. */
export async function run(argv: readonly string[]): Promise<number> {
  const keyFromEnvironment = (process.env.TYPESAFE_API_KEY ?? '').trim() !== '';
  const envFile = loadEnvLocal();

  let values: {
    goal?: string;
    'max-tokens'?: string;
    format?: string;
    safety?: boolean;
    json?: boolean;
    out?: string;
    help?: boolean;
    version?: boolean;
  };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    }));
  } catch (error: unknown) {
    throw new CliError(describeError(error), true);
  }

  if (values.help === true) {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  if (values.version === true) {
    process.stdout.write(`${packageVersion()}\n`);
    return EXIT_OK;
  }

  const [command, file, ...rest] = positionals;
  if (command === undefined) throw new CliError('missing command', true);
  if (!isCommand(command)) throw new CliError(`unknown command '${command}'`, true);
  if (command === 'doctor') {
    if (file !== undefined) throw new CliError(`unexpected argument '${file}'`, true);
    return doctor(keyFromEnvironment, envFile);
  }
  if (file === undefined) throw new CliError(`${command}: missing <file>`, true);
  if (rest.length > 0) throw new CliError(`unexpected argument '${rest[0] ?? ''}'`, true);

  const options: CompactOptions = {};
  if (values.goal !== undefined) options.goal = values.goal;
  const maxTokens = parseMaxTokens(values['max-tokens']);
  if (maxTokens !== undefined) options.maxTokens = maxTokens;
  const format = parseFormat(values.format);
  if (format !== undefined) options.format = format;
  if (values.safety === true) options.safetyGating = true;

  const source = file === '-' ? 'stdin' : file;
  const messages = parseMessages(await readInput(file), source);
  const result: CompactionResult = await compact(messages, options);

  const toFile = values.out !== undefined;
  // The summary, and — when the run failed open — why, so a silent no-op never looks like success.
  const summarize = (): void => {
    process.stderr.write(`${summaryLine(result)}\n`);
    if (result.report.error !== undefined) {
      process.stderr.write(`jev-compactor: jev unavailable: ${redact(result.report.error)}\n`);
    }
  };
  if (values.json === true) {
    writeOutput(jsonOf(redactResult(result)), values.out);
    summarize();
  } else if (command === 'compact') {
    writeOutput(jsonOf(result.messages), values.out);
    summarize();
  } else {
    const color = !toFile && wantColor();
    const width = !toFile && process.stdout.isTTY ? process.stdout.columns : undefined;
    const view = renderInspect(
      result,
      messages,
      width === undefined ? { color } : { color, width },
    );
    writeOutput(view, values.out);
    if (toFile) summarize();
  }

  return result.blocked ? EXIT_BLOCKED : EXIT_OK;
}

// ───────────────────────────── doctor ─────────────────────────────

const OK = '\u2713';
const BAD = '\u2717';

/**
 * Three checks, each printed as one line: the key is set (and where it came from), the Jev API
 * answers `GET /v1/models`, and `selfTest()` compacts the built-in history with its `rm -rf`
 * flagged by the regex floor and by Jev. Exit 1 on the first failure; every message is redacted.
 */
async function doctor(keyFromEnvironment: boolean, envFile: string | undefined): Promise<number> {
  const lines: string[] = [];
  const hasKey = (process.env.TYPESAFE_API_KEY ?? '').trim() !== '';
  if (hasKey) {
    const source = keyFromEnvironment ? 'the environment' : (envFile ?? 'the environment');
    lines.push(`${OK} API key      TYPESAFE_API_KEY read from ${source}`);
  } else {
    lines.push(
      `${BAD} API key      TYPESAFE_API_KEY is not set: export it, or put it in .env.local next to your package.json`,
    );
  }
  let failed = !hasKey;
  if (!failed) {
    const started = performance.now();
    try {
      const models = await createClient(resolveOptions({}, 'compact')).models.list();
      const names = models.map((m) => m.name).join(', ');
      lines.push(
        `${OK} Jev API      reachable in ${Math.round(performance.now() - started)} ms · models: ${names}`,
      );
    } catch (error: unknown) {
      failed = true;
      lines.push(`${BAD} Jev API      ${redact(describeError(error))}`);
    }
  }
  if (!failed) {
    const test = await selfTest();
    if (test.ok) {
      lines.push(
        `${OK} Compaction   ${test.model ?? 'jev'} answered in ${test.latencyMs ?? 0} ms · ${test.messagesBefore} → ${test.messagesAfter} messages · the built-in rm -rf was flagged by the regex floor and by Jev`,
      );
    } else {
      failed = true;
      lines.push(`${BAD} Compaction   ${test.stage}: ${redact(test.error ?? 'unknown failure')}`);
    }
  }
  lines.push(
    failed
      ? `Fix the ${BAD} line, then run \`jev-compactor doctor\` again.`
      : 'All good. In code, call status(client) on the wrapped client to see calls, compactions and the last report; pass verbose: true to withCompaction to log one line per call.',
  );
  process.stdout.write(`${lines.join('\n')}\n`);
  return failed ? EXIT_ERROR : EXIT_OK;
}

function main(): void {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`jev-compactor: ${describeError(error)}\n`);
      if (error instanceof CliError && error.usage) process.stderr.write(`\n${USAGE}`);
      process.exitCode = EXIT_ERROR;
    },
  );
}

main();
