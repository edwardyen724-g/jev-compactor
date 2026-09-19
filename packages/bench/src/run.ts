#!/usr/bin/env tsx
/**
 * Usage: pnpm --filter @jev-compactor/bench bench <file-or-dir>... [--goal "<text>"] [--max-tokens 15000]
 *        [--safety] [--baseline baselines/truncate.mjs] [--baseline baselines/anthropic.mjs]
 *        [--must-contain "<snippet>"]... [--out results/run.json]
 * Reads transcripts (Claude Code .jsonl, fast-jev-compaction JSON, or any messages JSON), compacts each
 * with jev-compactor, runs each baseline, and prints a markdown table.
 * Build the library first: pnpm --filter jev-compactor build
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  type AnyMessage,
  type CompactionResult,
  compact,
  loadEnvLocal,
  messagesTokens,
} from 'jev-compactor';
import { loadTranscript, type Transcript } from './convert.js';
import { pathFidelity, retention, transcriptText } from './metrics.js';

export interface BaselineContext {
  goal: string;
  maxTokens: number;
  /** The transcript flattened to text (for LLM baselines). */
  text: string;
}
export interface BaselineOutput {
  /** A message array (structural baselines) or a summary string (LLM baselines). */
  output: AnyMessage[] | string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
}
export interface Baseline {
  name: string;
  run(messages: AnyMessage[], ctx: BaselineContext): Promise<BaselineOutput>;
}

interface Arm {
  tokensAfter: number;
  saved: number;
  ms: number;
  usd: number;
  fidelity: number;
  hallucinated: string[];
  /** Share of --must-contain snippets that survive. 1 when none were given. */
  retention: number;
  /** The summary text for string outputs, kept so the numbers can be audited. */
  summary?: string;
  deterministic?: boolean;
  foreman?: number;
  skipped?: string;
}
interface Row {
  transcript: string;
  source: string;
  messages: number;
  tokensBefore: number;
  arms: Record<string, Arm>;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    goal: { type: 'string' },
    'max-tokens': { type: 'string', default: '15000' },
    safety: { type: 'boolean', default: false },
    baseline: { type: 'string', multiple: true, default: [] },
    'must-contain': { type: 'string', multiple: true, default: [] },
    out: { type: 'string' },
  },
});

loadEnvLocal(resolve(dirname(new URL(import.meta.url).pathname), '..'));
const maxTokens = Number(values['max-tokens']);
const mustContain = values['must-contain'];
const files = positionals.flatMap(expand);
if (files.length === 0) {
  console.error(
    'no transcripts given (drop .jsonl or .json files into packages/bench/local/ and pass the path)',
  );
  process.exit(1);
}
const baselines: Baseline[] = [];
for (const b of values.baseline)
  baselines.push(((await import(pathToFileURL(resolve(b)).href)) as { default: Baseline }).default);

const rows: Row[] = [];
for (const file of files) {
  let t: Transcript;
  try {
    t = loadTranscript(basename(file), readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`skip ${file}: ${(e as Error).message}`);
    continue;
  }
  if (t.messages.length < 4) continue;
  const tokensBefore = messagesTokens(t.messages);
  const opts = {
    ...(values.goal ? { goal: values.goal } : {}),
    maxTokens,
    safetyGating: values.safety,
    trigger: 'always' as const,
  };
  const first: CompactionResult = await compact(t.messages, opts);
  const second: CompactionResult = await compact(t.messages, opts);
  const goal = values.goal ?? first.report.goal;
  const row: Row = {
    transcript: t.name,
    source: t.source,
    messages: t.messages.length,
    tokensBefore,
    arms: {},
  };
  row.arms['jev-compactor'] = {
    ...arm(
      t.messages,
      first.messages,
      tokensBefore,
      first.report.jev?.latencyMs ?? 0,
      first.report.jev?.estimatedUsd ?? 0,
    ),
    deterministic: sameIndices(t.messages, first.messages, second.messages),
    foreman: first.report.foreman.length,
    ...(first.report.skipped ? { skipped: first.report.skipped } : {}),
  };
  const text = transcriptText(t.messages);
  for (const b of baselines) {
    try {
      const o = await b.run(t.messages, { goal, maxTokens, text });
      row.arms[b.name] = {
        ...arm(t.messages, o.output, tokensBefore, o.latencyMs, o.costUsd),
        ...(typeof o.output === 'string' ? { summary: o.output } : {}),
      };
    } catch (e) {
      console.error(`${t.name} / ${b.name}: ${(e as Error).message}`);
    }
  }
  rows.push(row);
  console.error(
    `${t.name}: ${Object.entries(row.arms)
      .map(
        ([k, a]) =>
          `${k} ${pct(a.saved)} saved, retention ${pct(a.retention)}, ${a.ms} ms, $${a.usd.toFixed(5)}`,
      )
      .join(' · ')}`,
  );
}

console.log(table(rows));
if (values.out) {
  mkdirSync(dirname(resolve(values.out)), { recursive: true });
  writeFileSync(resolve(values.out), JSON.stringify({ maxTokens, mustContain, rows }, null, 2));
  console.error(`wrote ${values.out}`);
}

function arm(
  original: AnyMessage[],
  output: AnyMessage[] | string,
  tokensBefore: number,
  ms: number,
  usd: number,
): Arm {
  const fid = pathFidelity(original, output);
  const tokensAfter =
    typeof output === 'string'
      ? messagesTokens([{ role: 'system', content: output }])
      : messagesTokens(output);
  const outText = typeof output === 'string' ? output : transcriptText(output);
  return {
    tokensAfter,
    saved: tokensBefore === 0 ? 0 : 1 - tokensAfter / tokensBefore,
    ms: Math.round(ms),
    usd,
    fidelity: fid.ratio,
    hallucinated: fid.hallucinated,
    retention: retention(outText, mustContain),
  };
}
function sameIndices(input: AnyMessage[], a: AnyMessage[], b: AnyMessage[]): boolean {
  const ia = a.map((m) => input.indexOf(m));
  const ib = b.map((m) => input.indexOf(m));
  return ia.length === ib.length && ia.every((v, i) => v === ib[i]);
}
function expand(p: string): string[] {
  const full = resolve(p);
  if (statSync(full).isDirectory())
    return readdirSync(full)
      .filter((f) => /\.jsonl?$/.test(f))
      .map((f) => join(full, f));
  return [full];
}
function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
function table(rows: Row[]): string {
  const arms = [...new Set(rows.flatMap((r) => Object.keys(r.arms)))];
  const lines: string[] = [];
  for (const name of arms) {
    lines.push(
      `### ${name}`,
      '',
      '| transcript | msgs | tokens before | tokens after | saved | latency ms | cost $ | path fidelity | hallucinated paths | evidence retention |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    const rs = rows.filter((r) => r.arms[name]);
    for (const r of rs) {
      const a = r.arms[name] as Arm;
      lines.push(
        `| ${r.transcript} | ${r.messages} | ${r.tokensBefore} | ${a.tokensAfter} | ${pct(a.saved)} | ${a.ms} | ${a.usd.toFixed(5)} | ${pct(a.fidelity)} | ${a.hallucinated.length} | ${pct(a.retention)} |`,
      );
    }
    if (rs.length > 1) {
      const avg = (f: (a: Arm) => number) =>
        rs.reduce((s, r) => s + f(r.arms[name] as Arm), 0) / rs.length;
      lines.push(
        `| **mean** | | | | ${pct(avg((a) => a.saved))} | ${Math.round(avg((a) => a.ms))} | ${avg((a) => a.usd).toFixed(5)} | ${pct(avg((a) => a.fidelity))} | ${rs.reduce((s, r) => s + (r.arms[name] as Arm).hallucinated.length, 0)} | ${pct(avg((a) => a.retention))} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
