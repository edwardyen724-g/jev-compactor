# Using jev-compactor

A walkthrough from install to a gated, compacted agent loop. Every command and snippet here was
run against the live Jev API before it was written down; the outputs shown are real.

## 0. What you are adding to your loop

When an agent's history grows past a token budget, jev-compactor sends an abridged copy of the
whole conversation to Jev once, gets back a keep/drop probability for every message plus four safety
signals, and returns a new array holding the **same message objects** minus the ones judged
droppable. Nothing kept is rewritten. The call takes a few hundred milliseconds and costs a fraction
of a cent. You read the reasons in `result.report`.

## 1. Install and set the key

```sh
npm install jev-compactor            # Node ≥ 20
export TYPESAFE_API_KEY=...          # or put it in .env.local next to your package.json
```

The CLI, the MCP server and the tests read the nearest `.env.local` / `.env`; the library reads
`process.env.TYPESAFE_API_KEY` (or `apiKey` in options).

## 2. Watch it decide before you wire it in

Save any conversation as a JSON array of messages (OpenAI, Anthropic, LangChain or plain shape) and
inspect it. Here the repo's own fixture: a 35-message coding session where the agent is fixing a
test, chats, proposes an `rm -rf`, and repeats a failing run.

```sh
npx jev-compactor inspect history.json --goal "Fix the failing unit test in src/auth.ts" --max-tokens 4000
```

```
goal     Fix the failing unit test in src/auth.ts
format   openai · 35 messages · 23 units
result   kept 24/35 messages · 5,541 → 4,079 tokens · jev 235 ms · $0.0002

PIN    u0   #0      system              124 tok  pinned:system                  You are a senior TypeScript…
PIN    u1   #1      user                 48 tok  pinned:goal-path auth.ts       Fix the failing unit test in…
PIN    u3   #4-6    tool:bash         1,024 tok  pinned:goal-path src/auth.ts   One test fails in `verifySes…
DROP   u4   #7      assistant           215 tok  jev:drop p=1.00                The failing case is `accepts…
DROP   u5   #8      user                 46 tok  jev:drop p=0.93                btw thanks for jumping on th…
FLAG   u7   #11     assistant           171 tok  flagged:destructive rm-recursive: rm -rf ./src
KEEP   u12  #19-20  tool:bash           192 tok  jev:keep p=0.56                Patch applied. Running the s…
PIN    u22  #34     user                 40 tok  pinned:recent                  Confirm the fix in src/auth…

foreman
  action  destructive   pattern  p=1.00  #11  rm-recursive: rm -rf ./src
  action  destructive   jev      p=0.96
```

How to read a line: `PIN` was never judged (system, recent, mentions a path from the goal, or
recent code); `DROP p=` is Jev's probability that the message is no longer needed; `KEEP` survived
the 0.7 threshold; `FLAG` is kept but implicated in a safety finding; `DUP` was an exact duplicate.
`--json` prints the full result; `compact` instead of `inspect` writes the compacted array.

## 3. Compact in code

```ts
import { compact } from 'jev-compactor';

const result = await compact(messages, {
  goal: 'Fix the failing unit test in src/auth.ts',
  maxTokens: 4_000,
});

console.log(result.messages.length, 'of', messages.length, 'messages kept');
console.log(result.report.tokensBefore, '→', result.report.tokensAfter, 'tokens');
console.log(result.report.jev?.latencyMs, 'ms,', result.report.jev?.estimatedUsd, 'USD');
for (const u of result.report.units) {
  if (u.decision === 'dropped') console.log('dropped', u.indices, u.reason, u.pKeep);
}
```

`result.messages[i] === messages[j]` for every kept message, so anything you attached to a message
object is still there. `compact()` always runs; the wrapper below only runs over budget.

## 4. Wrap your client instead

Two lines, no other changes. The wrapper compacts `params.messages` when the estimate exceeds
`maxTokens`, then calls the real method with the compacted array.

```ts
import OpenAI from 'openai';
import { withCompaction } from 'jev-compactor';

const openai = withCompaction(new OpenAI(), {
  maxTokens: 15_000,
  goal: (messages) => currentTask, // or a string, or omit: the last user message
  onReport: (report) => log.info({ compaction: report }),
});

const res = await openai.chat.completions.create({ model: 'gpt-4o', messages });
```

Anthropic clients work the same (`messages.create`); a corrective prompt, when one is due, is
appended to `params.system`. A LangChain runnable's `invoke` is wrapped when its input is a message
array or `{ messages }`. A plain function `(messages, ...rest) => …` is wrapped directly. After a
compaction, the next `cooldownTurns` calls (default 1) skip Jev.

## 4b. Confirm it is wired in

Nothing changes visibly when the wrapper is idle: below `maxTokens` every call passes straight
through. So check, once, from the outside and from the inside.

```sh
npx jev-compactor doctor
```

```
✓ API key      TYPESAFE_API_KEY read from /Users/you/project/.env.local
✓ Jev API      reachable in 212 ms · models: jev-latest, jev-preview
✓ Compaction   jev-1.13.0 answered in 287 ms · 9 → 6 messages · the built-in rm -rf was flagged by the regex floor and by Jev
All good. …
```

A ✗ names the stage (key, Jev API, compaction) and what to do; the command exits 1 so it can sit
in a start-up script or CI.

```ts
import { withCompaction, status } from 'jev-compactor';

const openai = withCompaction(new OpenAI(), { maxTokens: 15_000, verbose: true });
console.log(status(openai));
// { wrapped: true, shape: 'openai', trigger: 'auto', maxTokens: 15000, calls: 0, compactions: 0, … }
```

`status(x)` is `undefined` unless `x` came out of `withCompaction`, which catches the classic
mistake of wrapping the client and then keeping the original. After each call the counters move:
`calls` always, `skipped.below_threshold` while the history is small, `compactions` once it is not,
`blocked` when the gate fired; `lastReport` is the full report of the latest call. With
`verbose: true` the wrapper also prints one line per call to stderr:

```
jev-compactor: kept 35/35 messages · 5,541 → 5,541 tokens · skipped: below_threshold
jev-compactor: kept 24/35 messages · 5,541 → 4,079 tokens · jev 235 ms · $0.0002
```

The first line is the wrapper saying "I saw the call, nothing to do yet"; the second is a
compaction. If you never see the first line, the wrapper is not in the path.

## 5. Tune it

| You want | Set |
|---|---|
| A smaller context | lower `maxTokens` — but pins (system, recent, goal paths, code) are never dropped, so the report may say the budget was unreachable |
| Fewer drops | raise `dropThreshold` (default 0.7 = drop when Jev is ≥ 70% sure) |
| Protect specific messages | `pin: (index, message) => boolean`, or mention the file path in `goal` — units mentioning a goal path are pinned automatically |
| More recent turns untouched | `keepRecent` (default 4 units) |
| Your tokenizer | `countTokens: (text) => number` (tiktoken, a provider's count endpoint) |
| Run every turn | `trigger: 'always'` on the wrapper |
| The same history compacted the same way every time | `votes: 3` — Jev's answers drift a little between identical requests; averaging three narrows it at 3× a fraction of a cent |

## 6. Turn on the safety gate

```ts
import { withCompaction, CompactionBlockedError } from 'jev-compactor';

const agent = withCompaction(new OpenAI(), {
  maxTokens: 15_000,
  safetyGating: true,
  onEscrow: async (finding, result) => {
    // finding.kind: 'destructive' | 'exfiltration'; finding.evidence: 'rm-recursive: rm -rf ./src'
    return (await askAHuman(finding)) ? 'approve' : 'block';
  },
});

try {
  await agent.chat.completions.create({ model, messages });
} catch (e) {
  if (e instanceof CompactionBlockedError) {
    console.error('blocked:', e.finding.kind, e.finding.evidence); // e.result has the full report
  } else throw e;
}
```

The gate looks at the **pending action** — the agent's newest message or tool call. A regex floor
(`rm -rf`, `git push --force`, `DROP TABLE`, `curl | sh`, keys in outbound commands …) runs even when
Jev is unreachable; Jev adds a calibrated probability for things regexes cannot see. Earlier
proposals the user already rejected are reported and flagged but never block; a looping agent gets
a corrective system message, not a block.

## 7. Use it from Claude Code, Cursor or any MCP client

```sh
claude mcp add jev-compactor --env TYPESAFE_API_KEY=... -- npx -y --package=jev-compactor jev-compactor-mcp
```

Tools: `compact_context` (messages in, kept messages + report out), `inspect_context` (the view
above as text) and `check_action` (the Foreman alone, over one proposed command — handy as a
pre-flight before a shell tool runs). Python agents (CrewAI, custom loops) use this bridge.

## 8. Read the report

`report.units[]` has one entry per unit with `decision`, `reason`, `pKeep`, `confidence`,
`indices`, `tokens`. `report.foreman[]` lists findings with `source` (`pattern` or `jev`),
`probability`, `level` (`review` ≥ 0.35, `action` ≥ 0.70) and `evidence`. `report.jev` has
`requests`, `inputTokens`, `latencyMs`, `estimatedUsd`, `fitStage` (how hard the state had to be
abridged) and `unjudged` (units Jev never saw — they are kept). `report.skipped` tells you when
nothing ran (`below_threshold`, `cooldown`, `nothing_to_judge`, `jev_unavailable`).

## 9. Benchmark your own sessions

```sh
pnpm --filter jev-compactor build
# drop transcripts into packages/bench/local/ (gitignored): Claude Code .jsonl, or any messages JSON
pnpm --filter @jev-compactor/bench bench local --max-tokens 15000 --baseline baselines/truncate.mjs \
  --must-contain "a fact stated early that the agent must still know"
```

The output is a markdown table per arm: tokens saved, latency, cost, path fidelity, evidence
retention. Add `--baseline baselines/anthropic.mjs` (needs `ANTHROPIC_API_KEY`) to compare with
LLM summarization.

## 10. Things to know

- **Data leaves your machine.** An abridged copy of the conversation goes to `api.typesafe.ai`.
- **Jev is not bit-stable.** The same request can return P(keep) values a few hundredths apart; a
  message near the threshold can flip between runs. Raise `dropThreshold` if that matters.
- **Fail-open.** No key, a 401, a timeout: the history goes through unchanged with
  `report.skipped = 'jev_unavailable'`; set `failClosed: true` to throw instead.
- **`rm -rf node_modules` is flagged.** The regex floor is conservative by design; pass your own
  `patterns` to relax it.
- **Anthropic and system prompts.** Anthropic keeps `system` outside the array, so the corrective
  prompt comes back as `result.systemAddendum` when you call `compact()` directly (the wrapper
  handles it). A text-only Anthropic history detects as `plain`; pass `format: 'anthropic'`.
