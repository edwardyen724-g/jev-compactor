// Run compaction N times on one transcript and report every unit whose decision differs between
// runs, with its P(keep) per run. Usage: node scripts/determinism.mjs <file> [--runs 3] [--max-tokens 6000]
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { compact, loadEnvLocal } from 'jev-compactor';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    runs: { type: 'string', default: '3' },
    'max-tokens': { type: 'string', default: '6000' },
    goal: { type: 'string' },
    votes: { type: 'string', default: '1' },
  },
});
loadEnvLocal(new URL('..', import.meta.url).pathname);
const file = positionals[0];
if (!file) throw new Error('usage: node scripts/determinism.mjs <file>');
const raw = JSON.parse(readFileSync(file, 'utf8'));
const messages = Array.isArray(raw) ? raw : raw.messages;
const n = Number(values.runs);
const runs = [];
for (let i = 0; i < n; i++) {
  runs.push(
    await compact(messages, {
      maxTokens: Number(values['max-tokens']),
      trigger: 'always',
      votes: Number(values.votes),
      ...(values.goal ? { goal: values.goal } : {}),
    }),
  );
}
const ids = runs[0].report.units.map((u) => u.unit);
let differing = 0;
let maxSpread = 0;
for (const id of ids) {
  const rs = runs.map((r) => r.report.units.find((u) => u.unit === id));
  const decisions = rs.map((u) => u.decision);
  const p = rs.map((u) => u.pKeep).filter((x) => x !== undefined);
  if (p.length > 1) maxSpread = Math.max(maxSpread, Math.max(...p) - Math.min(...p));
  if (new Set(decisions).size > 1) {
    differing++;
    console.log(
      `${id.padEnd(5)} decisions ${decisions.join('/')}  pKeep ${rs.map((u) => (u.pKeep === undefined ? '-' : u.pKeep.toFixed(2))).join('/')}  ${rs[0].reason}`,
    );
  }
}
console.log(
  `runs ${n} · units ${ids.length} · units with differing decisions ${differing} · max P(keep) spread across runs ${maxSpread.toFixed(3)}`,
);
console.log(
  `tokensAfter ${runs.map((r) => r.report.tokensAfter).join('/')} · messagesAfter ${runs.map((r) => r.messages.length).join('/')} · fitStage ${runs.map((r) => r.report.jev?.fitStage).join('/')} · requests ${runs.map((r) => r.report.jev?.requests).join('/')}`,
);
