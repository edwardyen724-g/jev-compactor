# jev-compactor

Deterministic context compaction and safety gating for AI agents, powered by
[TypeSafe's Jev](https://typesafe.ai). Source, docs and benchmark:
[github.com/edwardyen724-g/jev-compactor](https://github.com/edwardyen724-g/jev-compactor). Framework-agnostic: it works on OpenAI, Anthropic, LangChain
and plain `{role, content}` message arrays, wraps your existing client in two lines, and ships as a
CLI and an MCP server. **Jev judges relevance; code decides structure.** Jev answers one bounded
question per message — *does this stay in working memory for the goal?* — with a calibrated
probability, in a single ~300 ms request. Everything that must be guaranteed is plain TypeScript
that runs whether or not Jev is available or right: kept messages are the caller's own objects, byte
for byte; a tool call is never separated from its result; system messages are never dropped; every
drop carries a reason and a probability in the report; destructive commands, secret exfiltration,
thrashing loops and goal drift are caught in the same pass (with a regex floor that needs no model),
and can block the model call until an escrow hook approves. When Jev cannot be reached, the history
goes through unchanged.

## Install

```sh
npm install jev-compactor
```

Node ≥ 20. You need a TypeSafe API key in `TYPESAFE_API_KEY` (or pass `apiKey`). The CLI, the MCP
server and the tests also read the nearest `.env.local` / `.env`.

## Two lines

```ts
import { withCompaction } from 'jev-compactor';

const openai = withCompaction(new OpenAI(), { maxTokens: 15_000, safetyGating: true });
```

Nothing else changes: `openai.chat.completions.create({ model, messages })` works as before. When
the estimated size of `messages` exceeds `maxTokens`, the history is compacted first and the model
receives a new array holding the same message objects, minus the ones judged droppable. After a
compaction the next `cooldownTurns` calls (default 1) pass straight through.

`withCompaction(target, options)` detects the target's shape, never mutates it, and returns a proxy
of the same type:

| Target | What is wrapped |
|---|---|
| a function `(messages, ...rest) => …` | `messages` |
| an OpenAI-style client (`chat.completions.create`) | `params.messages` |
| an Anthropic-style client (`messages.create`) | `params.messages`; a corrective prompt is appended to `params.system` |
| a LangChain-style runnable (`invoke`) | a message array, or `{ messages }` |

Anything else throws `UnsupportedTargetError` (so does a frozen client, which a Proxy cannot
intercept). The wrapped `create`/`invoke` still returns a promise with the SDK's `.withResponse()`
and `.asResponse()`.

With `safetyGating: true`, a call whose **pending action** — the agent's latest message or tool
call — carries an action-level `destructive` or `exfiltration` finding (an `rm -rf`, a force-push,
a key sent to an external host …) throws `CompactionBlockedError` — carrying the finding and the
full result — instead of reaching the model, unless your `onEscrow` hook returns `'approve'`. The
gate runs on every call, over budget or not: the regex floor needs no network. Findings about
earlier turns (a proposal the user already rejected, the user's own warning, a command a tool
result merely quotes) are reported and flagged but do not block, and thrashing or goal drift never
block — they inject the corrective prompt. A blocked call never arms the cooldown, so a retry is
gated again.

## `compact()`

```ts
import { compact } from 'jev-compactor';

const result = await compact(messages, {
  goal: 'Fix the failing unit test in src/auth.ts',
  maxTokens: 8_000,
});

result.messages;       // the kept originals: result.messages[i] === messages[j]
result.report;         // every decision, with reason and probability; tokens, latency, cost
result.blocked;        // true only with safetyGating and an action-level finding
result.systemAddendum; // corrective prompt, for Anthropic-shaped input (system lives outside the array)
result.compacted;      // false when the run was skipped (see report.skipped)
```

`compact()` runs on every call (`trigger: 'always'`); `withCompaction` runs only over budget
(`trigger: 'auto'`). `createCompactor(options)` returns a reusable `{ compact, options, client }`
that builds the Jev client once. `goal` may be a string, a function `(messages, frames) => string`,
or omitted (the last user message, up to 500 characters).

### What happens inside

1. **Normalize.** Any supported message shape becomes frames; an assistant message that issues tool
   calls and the tool messages that answer it form one *unit*, kept or dropped together.
2. **Pre-pass, in code.** Pinned and never judged: every system message, the last `keepRecent`
   units, units mentioning a file path or URL the goal mentions, code blocks and diffs within the
   last `pinCodeWithin` units, anything you pin. Exact duplicates are deduped (the last copy
   survives). A fixed regex list flags `rm -rf`, `git push --force`, `git reset --hard`, `DROP
   TABLE`, `curl | sh`, keys in outbound commands, `.env` reads and the like — unconditionally.
3. **Skeleton state.** The whole conversation, abridged in stages to fit Jev's limits (long tool
   results become `ok, 4213 chars (omitted)`), is sent as read-only state — never a slice, because
   "superseded by a later message" needs the later message in view.
4. **Jev, one request.** One `choice` question per candidate unit, plus `noul` questions for
   destructive commands, exfiltration, thrashing and goal drift and a progress score, all answered
   in parallel with calibrated probabilities. Typically 0.2–0.5 s and ≈ $0.001 for a 25k-token
   history (Jev bills $0.042 per million input tokens).
5. **Decide, in code.** A unit is dropped only when P(drop) ≥ `dropThreshold` (0.7 — when in doubt,
   keep). `minKeep` units always survive. Still over `maxTokens`? A second pass at 0.5, then the
   least-certain keeps go, lowest P(keep) first (oldest first on ties), deterministically, reported as `budget`.
6. **Reassemble.** `messages.filter(byIndex)`: the original objects, original order. If Jev saw the
   agent looping or drifting, a short corrective system message is appended (`false` to disable).
   It is appended as a *trailing* system message for the `openai`, `langchain` and `plain` formats
   (OpenAI accepts that) and returned as `systemAddendum` for `anthropic`; a LangChain runnable
   backed by Anthropic or Gemini rejects a system message past index 0, and a text-only Anthropic
   history passed to `compact()` detects as `plain` — pass `format: 'anthropic'` there, or
   `correctivePrompts: false` and act on `report.foreman` yourself.

## CLI

```
jev-compactor compact <file> [options]   write the compacted messages (JSON) to stdout or --out
jev-compactor inspect <file> [options]   show every unit's decision, the Foreman findings and the corrective prompt

  <file> is a JSON array of messages or {"messages": [...]}; "-" reads stdin.

Options:
  --goal <text>        the agent's goal (default: the last user message)
  --max-tokens <n>     token budget in estimated tokens (default 15000)
  --format <f>         auto | openai | anthropic | langchain | plain (default auto)
  --safety             run the Foreman gate; exit 2 when an action-level finding blocks
  --json               print the full CompactionResult instead
  --out <file>         write the output to <file> instead of stdout

Exit codes: 0 ok, 1 error, 2 blocked (with --safety).
```

`compact` prints a one-line summary to stderr — `kept 24/35 messages · 5,541 → 3,682 tokens · jev
296 ms · $0.0002` — followed by `jev-compactor: jev unavailable: <reason>` when the run failed open
(a missing key, a bad URL, a 401 …), so a silent no-op never looks like success; `inspect` renders
the decision stream (green `KEEP`, dim struck-through `DROP` with its probability, red `FLAG`, blue
`PIN`, yellow `DUP`; plain text when piped):

```
$ npx jev-compactor inspect history.json --goal "Fix the failing unit test in src/auth.ts" --max-tokens 4000
goal     Fix the failing unit test in src/auth.ts
format   openai · 35 messages · 23 units
result   kept 24/35 messages · 5,541 → 3,682 tokens · jev 296 ms · $0.0002

PIN    u0   #0      system              124 tok  pinned:system                  You are a senior TypeScript…
PIN    u1   #1      user                 48 tok  pinned:goal-path auth.ts       Fix the failing unit test in…
DROP   u2   #2-3    tool:bash           589 tok  budget p=0.20                  Reproducing the failure first…
PIN    u3   #4-6    tool:bash         1,024 tok  pinned:goal-path src/auth.ts   One test fails in `verifySes…
DROP   u4   #7      assistant           215 tok  jev:drop p=1.00                The failing case is `accepts…
DROP   u5   #8      user                 46 tok  jev:drop p=0.93                btw thanks for jumping on th…
FLAG   u7   #11     assistant           171 tok  flagged:destructive rm-recursive: rm -rf ./src (was pinned:…
KEEP   u12  #19-20  tool:bash           192 tok  jev:keep p=0.56                Patch applied. Running the s…
PIN    u15  #23-24  tool:apply_patch    352 tok  pinned:code                    Adding the boundary test.…
PIN    u22  #34     user                 40 tok  pinned:recent                  Confirm the fix in src/auth…

foreman
  action  destructive   pattern  p=1.00  #11  rm-recursive: rm -rf ./src
  action  destructive   jev      p=0.96
```

(Excerpt; previews shortened.)

## MCP server

`jev-compactor-mcp` speaks MCP over stdio. Register it with any MCP client, for example:

```json
{
  "mcpServers": {
    "jev-compactor": {
      "command": "npx",
      "args": ["-y", "--package=jev-compactor", "jev-compactor-mcp"],
      "env": { "TYPESAFE_API_KEY": "…" }
    }
  }
}
```

| Tool | Input | Output |
|---|---|---|
| `compact_context` | `{ messages, goal?, maxTokens?, safetyGating?, format? }` | `{ messages, report, blocked, systemAddendum? }` |
| `inspect_context` | `{ messages, goal? }` | the `inspect` view as text, then the report as JSON |
| `check_action` | `{ action, goal? }` | `{ findings, blocked }` — the Foreman alone, over one proposed command or tool call |

Errors come back as `isError` results, never as a dropped connection. This is also the bridge for
non-JavaScript agents (CrewAI, custom loops): send the history, get the kept subset back.

## LangChain

`withCompaction(model)` wraps any runnable whose `invoke` takes a message array or `{ messages }`;
`compact()` accepts LangChain messages (`type: human | ai | system | tool`, or class instances) and
returns the same objects, so it also fits in a `RunnableLambda` ahead of the model. Python agents use
the MCP server.

## Options

Every field of `CompactOptions` (`withCompaction` also takes `cooldownTurns`):

| Option | Default | Meaning |
|---|---|---|
| `goal` | last user message, ≤ 500 chars | The agent's active goal: a string or `(messages, frames) => string`. |
| `maxTokens` | `15_000` | Budget and trigger threshold, in estimated tokens. |
| `trigger` | `'always'` (`compact`), `'auto'` (`withCompaction`) | `auto` compacts only when the estimate exceeds `maxTokens`. |
| `keepRecent` | `4` | Newest units, never judged. |
| `pinCodeWithin` | `12` | Units containing code or diffs within this many units of the end are pinned. |
| `pin` | — | `(index, message) => boolean` extra pins. A message with `pin: true` is pinned too — but kept messages are your own objects, so that field reaches the provider verbatim, and OpenAI and Anthropic reject unknown message fields: with a real client use the callback. |
| `dropThreshold` | `0.7` | Drop iff P(drop) ≥ this. |
| `dropThresholdSecondPass` | `0.5` | Threshold for the second pass when still over budget. |
| `minKeep` | `2` | Judged units that always survive (pins are on top). |
| `allowTruncate` | `false` | Reserved for v0.2 (keep the call, truncate the result). |
| `truncateHeadChars` | `300` | Characters of a tool result Jev sees before the omitted-note. |
| `excerptChars` | `1_500` | Characters of a unit Jev sees (head + tail) before abridging kicks in. |
| `stateTokens` | `20_000` | Budget for the skeleton state (Jev's hard limit is 32k). |
| `requestTokens` | `56_000` | Budget for state + questions per request (limit 64k); questions are batched beyond it. |
| `concurrency` | `8` | Concurrent Jev requests. |
| `safetyGating` | `false` | Honor `blocked`. Findings are reported either way. |
| `reviewThreshold` | `0.35` | A Jev finding at/above this is `review`. |
| `actionThreshold` | `0.70` | … and at/above this is `action`. |
| `patterns` | built-in list | Regex floor: an array replaces it; a function receives the defaults and returns the full list. |
| `correctivePrompts` | built-in templates | `{ thrashing?, goal_drift? }` overrides (`{goal}` is substituted); `false` disables injection. The note is a trailing system message (openai, langchain, plain) or `systemAddendum` (anthropic); see step 6 for providers that reject a trailing system message. |
| `failClosed` | `false` | Throw `CompactionUnavailableError` instead of returning the input unchanged when Jev is unavailable. |
| `countTokens` | `chars / 2.5` | Token counter for the original messages (tiktoken, a provider's count endpoint …). |
| `format` | `'auto'` | Force an adapter: `openai`, `anthropic`, `langchain`, `plain`. |
| `client` | — | An injected `TypeSafeClient`; otherwise one is built from the fields below and `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`. The log level is pinned to `warn` (`debug` would log request bodies), so `TYPESAFE_LOG_LEVEL` is not honored. |
| `apiKey`, `model`, `baseURL` | env, env then `jev-latest`, env | Jev client settings. |
| `timeoutMs` | `10_000` | Per-attempt Jev timeout. |
| `signal` | — | Aborts in-flight Jev requests; a cancelled `compact()` rejects with the abort error (never fails open or closed) and a wrapped target is not called. |
| `onReport` | — | `(report) => void`, called on every run, skipped ones included. |
| `onEscrow` | — | `(finding, result) => 'approve' \| 'block'` (may be async), called with the finding about the pending action when `safetyGating` blocks. A hook that throws counts as `'block'`. |
| `cooldownTurns` | `1` | `withCompaction` only: calls of the same conversation (keyed on its first user message) that skip Jev after a run — a fail-open attempt included, so an unreachable Jev is not retried every turn. A blocked call never arms it, and skipped calls still run the regex floor and the gate. |

## The report

```ts
interface CompactionResult<M> {
  messages: M[];            // kept originals (=== the input objects), plus at most one corrective system message
  report: CompactionReport;
  blocked: boolean;         // safetyGating && an action-level finding && escrow did not approve
  systemAddendum?: string;  // the corrective prompt, for Anthropic-shaped input
  compacted: boolean;       // false when skipped
}

interface CompactionReport {
  goal: string;
  format: 'openai' | 'anthropic' | 'langchain' | 'plain';
  tokensBefore: number;  tokensAfter: number;      // estimated
  messagesBefore: number; messagesAfter: number;
  units: UnitReport[];                             // one per unit, in order
  foreman: ForemanFinding[];                       // action first, then by probability
  progress?: number;                               // Jev's 0–2 progress score
  jev?: JevTelemetry;
  skipped?: 'below_threshold' | 'cooldown' | 'nothing_to_judge' | 'jev_unavailable';
  error?: string;                                  // why it failed open
  latencyMs: number;
}

interface UnitReport {
  unit: string;                 // 'u12'
  indices: number[];            // original message indices
  decision: 'kept' | 'pinned' | 'dropped' | 'duplicate' | 'budget' | 'flagged';
  pKeep?: number;  confidence?: number;
  reason: string;               // 'pinned:goal-path src/auth.ts', 'jev:drop p=0.93', 'duplicate of u19', 'budget'
  tokens: number;
}

interface ForemanFinding {
  kind: 'destructive' | 'exfiltration' | 'thrashing' | 'goal_drift';
  source: 'pattern' | 'jev';    // regex floor (probability 1) or Jev's noul
  probability: number;
  level: 'review' | 'action';
  indices: number[];            // the messages a pattern hit, or the pending action a Jev
                                // destructive/exfiltration noul judged; [] for whole-state findings
  evidence?: string;            // 'rm-recursive: rm -rf ./src'
}

interface JevTelemetry {
  model: string;  requests: number;  inputTokens: number;  outputTokens: number;
  latencyMs: number;  requestIds: string[];  estimatedUsd: number;
  stateTokens: number;  fitStage: number;    // abridging stage reached (0 = none, 5 = candidates omitted)
  unjudged: number;                          // units Jev never saw (omitted, or in a failed batch); they are kept
}
```

`requests`, `requestIds` and `latencyMs` cover every request of the run, including the ones Jev
rejected while the state was being re-abridged.

## Failure policy

Jev unreachable, a bad key, a rate limit, a timeout: the input comes back unchanged with
`report.skipped = 'jev_unavailable'` and `report.error` set. The regex Foreman still runs and its
findings are still reported. `failClosed: true` throws `CompactionUnavailableError` instead, for
deployments where an uncompacted history must not reach the model. Your own cancellation
(`signal`) is neither: the call rejects with the abort error. When one question batch of several
fails, it drops out and its units are kept as unjudged while the others are applied; the run only
fails open as a whole when the batch carrying the Foreman failed. When Jev rejects the state as too
large — it tokenizes CJK and dense JSON far denser than the 2.5 chars/token estimate — the state is
re-abridged, one stage further and against a tighter budget, until it is accepted. The CLI and the
MCP server scrub the API key from every report and error text they print, unit previews included.

## Benchmark

On one 64-message, 12.7k-token agent session with a 6k-token budget, jev-compactor cut tokens by
64.5% in 366 ms for $0.0004 with zero hallucinated file paths and all 4 early facts retained;
oldest-first truncation cut 53.0% but kept 1 of 4 facts; Claude Sonnet 5 summarization cut 96.2% in
6.1 s for $0.0305 and wrote one file path that does not exist in the transcript. Measured 2026-09-18
with `jev-1.13.0`; metrics, raw results and reproduce commands:
[docs/BENCHMARK.md](https://github.com/edwardyen724-g/jev-compactor/blob/main/docs/BENCHMARK.md).
A step-by-step walkthrough:
[docs/TUTORIAL.md](https://github.com/edwardyen724-g/jev-compactor/blob/main/docs/TUTORIAL.md).

## Data leaves your machine

When compaction runs, an abridged copy of the conversation — the goal and an excerpt of every
message, tool inputs and the head of tool results included — is sent to `api.typesafe.ai` and
judged there. Nothing is sent when a run is skipped (below threshold, cooldown) and the regex floor
runs locally, but a compaction is a network call carrying your agent's history. Review your data
policy and TypeSafe's before enabling it on private code or customer data.

MIT © 2026 Edward Yen
