# Benchmark: jev-compactor vs what your framework already does

The control arms are the **real compaction mechanisms of real agent products**, ported from their
open-source code — prompt verbatim and algorithm (what is kept, in which role, at which thresholds)
— plus Anthropic's official server-side compaction API. Each port's header comment cites the
upstream file, revision and license and says whether it is exact or approximate and why; the full
table is in [`packages/bench/baselines/README.md`](../packages/bench/baselines/README.md). Products
whose mechanism is closed (Claude Code's own `/compact`, Copilot CLI, Cursor, Amp) or opaque
(OpenAI's and xAI's `/responses/compact`, which return encrypted items) are listed there with their
documented behaviour and no numbers.

Measured 2026-09-19 on transcripts checked into this repo. Jev `jev-1.13.0`; Claude Sonnet 5 where
a product uses "the user's model"; each product's own default model through OpenRouter otherwise.
Raw results: [`docs/benchmark/product-baselines-long-noisy.json`](benchmark/product-baselines-long-noisy.json),
[`docs/benchmark/product-baselines-long-noisy-55k.json`](benchmark/product-baselines-long-noisy-55k.json),
[`docs/benchmark/product-baselines-long-noisy-claude-on-demand.json`](benchmark/product-baselines-long-noisy-claude-on-demand.json).

## Metrics

- **saved** — 1 − tokens after / tokens before, with the same 2.5-chars-per-token estimate for every arm.
- **latency / cost** — wall-clock and dollars of the compaction call itself: Jev's reported usage;
  OpenRouter's own `usage.cost`; Anthropic at list price ($2 / $10 per million).
- **references not in the transcript** — file paths, URLs and identifiers in the output that do not
  occur in the original. For a summary that is a hallucinated or altered reference; for jev-compactor
  it is impossible by construction. Product boilerplate counts too (Hermes' summary header names
  `MEMORY.md` and `USER.md`), so read the note under the table.
- **evidence retained** — how many of four facts the agent needs at the end of the session survive
  verbatim: two ticket ids (`OPS-2291`, `API-1187`), a schema-freeze constraint and the original
  failure text, all stated **only in the first turns**.

## The session: 64 messages, 12,667 tokens, budget 6,000

`packages/bench/fixtures/long-noisy-openai.json`, generated deterministically by
`fixtures/gen-long.mjs`: an agent is asked to fix a flaky idempotency test under two constraints,
detours through an unrelated eslint upgrade (an `npm install` log, 23 lint errors, seven patches),
repeats the identical failing run three times, chats about a broken coffee machine, and fixes the
bug. One run per arm (LLM arms vary between runs; see below).

| arm | what it does | tokens after | saved | latency | cost | refs not in transcript | evidence retained |
|---|---|---|---|---|---|---|---|
| **jev-compactor** | drop whole messages Jev rates irrelevant; keep the rest verbatim | 3,365 | **73.4%** | **350 ms** | **$0.0004** | **0** | **4 of 4** |
| Anthropic compaction API (published default prompt, client path) | summary block replaces everything before it | 1,754 | 86.2% | 16.8 s | $0.043 | 0 | 3 of 4 |
| Codex CLI `/compact` (gpt-6-astra) | summary + recent user messages replace the history | 1,949 | 84.6% | 1.0 s | $0.049 | 0 | 3 of 4 |
| Gemini CLI `/compress` (gemini-3.1-pro-preview) | `<state_snapshot>` + last 30% of history | 4,999 | 60.5% | 16.8 s | $0.083 | 0 | 4 of 4 |
| Grok Build `/compact` (grok-4.6) | full-replace summary | 3,361 | 73.5% | 0.5 s | $0.020 | 1 | 4 of 4 |
| OpenCode `/compact` (Sonnet 5) | structured summary as an assistant message | 1,957 | 84.6% | 17.4 s | $0.038 | 0 | 3 of 4 |
| LangChain `SummarizationMiddleware` (Sonnet 5) | summary of older messages + last 20 verbatim | 4,265 | 66.3% | 10.4 s | $0.013 | 0 | 1 of 4 |
| Hermes Agent `ContextCompressor` (Sonnet 5) | prune old tool output, summarize the head, keep a tail | 4,010 | 68.3% | 24.5 s | $0.049 | 2 | 4 of 4 |
| goose (Sonnet 5) | structured summary + continuation notice | 4,703 | 62.9% | 60.8 s | $0.099 | 0 | 4 of 4 |
| Aider `ChatSummary` (Sonnet 5) | summarize only above its 8,192-token history limit | 12,682 | 0% (did not trigger) | 0 ms | $0 | 0 | 4 of 4 |
| Vercel AI SDK `pruneMessages` | drop tool calls/results except the last 2 messages (no model) | 1,588 | 87.5% | 1 ms | $0 | 0 | 3 of 4 |
| oldest-first truncation | drop the oldest turns until it fits (no model) | 5,957 | 53.0% | 1 ms | $0 | 0 | 1 of 4 |
| generic "summarize this" prompt (Sonnet 5) | one continuation summary | 403 | 96.8% | 4.3 s | $0.030 | 0 | 3 of 4 |

Reading it:

- **Every model-based product mechanism costs 30–250× more and takes 1.4–170× longer** than
  jev-compactor on this session, and half of them (Anthropic's API, Codex, OpenCode, the generic
  summary) lost one of the four facts. LangChain's middleware lost three, structurally: it shows the
  summarizer only the last 4,000 tokens of the range it replaces, so the early constraints never
  reach the model.
- **Summaries compress harder.** Where a product replaces the history with prose it reaches 84–97%
  saved; jev-compactor, which never rewrites, reached 73% here and 53–76% across runs (below).
  That is the trade: verbatim evidence and attributable drops for a bigger remaining context.
- **The two model-free approaches are free and blind.** Truncation keeps the recent half and loses
  three facts; the AI SDK's structural prune keeps all prose and drops all but the last two tool
  exchanges, losing one fact and every tool result the agent might need.
- The Grok and Hermes "references not in the transcript" are `docs/…` and `MEMORY.md`/`USER.md`
  written by their own summary templates, not hallucinated file paths; Aider's row is its real
  behaviour (it does not summarize a history under 8,192 tokens), not a failed run.

### Run-to-run variance

LLM arms are not deterministic: Codex kept 4 of 4 facts in an earlier run of the same session and
3 of 4 in this one; goose's latency ranged 48–61 s. jev-compactor's *decisions* are deterministic
given Jev's answers, but Jev's probabilities move a few hundredths between identical requests, and
two units in this session sit near the 0.7 drop threshold. Measured with
`packages/bench/scripts/determinism.mjs`:

| setting | runs | tokens after | saved | evidence retained |
|---|---|---|---|---|
| `votes: 1` (default) | 12 | 3,097 – 5,961 (mode 4,423) | 53% – 76% (mode 65%) | 4 of 4 in every benchmark run |
| `votes: 3` | 5 | 3,365 – 4,423 (4 of 5 at 4,423) | 65% – 73% | 4 of 4 |

`votes: 3` asks every question three times in parallel and averages: the maximum P(keep) spread
across runs fell from 0.16 to 0.07, at 3× a fraction of a cent and no added latency.

## Where it matters most: 289 messages, 61,263 tokens, budget 20,000

`fixtures/long-noisy-openai-55k.json` (`gen-long.mjs --scale 6`) is large enough for Anthropic's
real threshold compaction (beta `compact-2026-01-12`, minimum trigger 50,000 real input tokens;
this transcript is 64,718). This is the API's actual sampling step, `stop_reason: compaction`.

| arm | tokens after | saved | latency | cost | refs not in transcript | evidence retained |
|---|---|---|---|---|---|---|
| **jev-compactor** | 2,847 | 95.4% | **593 ms** | **$0.0014** | 0 | **4 of 4** |
| Anthropic compaction API (real, threshold) | 1,486 | 97.6% | 14.6 s | $0.145 | 0 | 3 of 4 |

The compaction iteration billed 65,277 input and 1,453 output tokens and the summary lost the
migration-freeze constraint. jev-compactor abridged the state to fit Jev's 32k limit (fit stage 5,
oldest candidates omitted and therefore kept), then dropped 95% of the session in one request.

## Short, dense sessions: the conservative case

The four 33–35-message fixtures in `packages/jev-compactor/fixtures/` (the same story in the
OpenAI, Anthropic, LangChain and plain formats, ~5,500 tokens each, nearly every message on-topic)
with a 4,000-token budget, against truncation and the generic summary:

| arm | saved (mean) | latency (mean) | cost (mean) | refs not in transcript (total) | evidence retained (mean) |
|---|---|---|---|---|---|
| **jev-compactor** | 23.8% | 295 ms | $0.0002 | **0** | **100%** |
| oldest-first truncation | 25.6% | 0 ms | $0 | 0 | 75% |
| generic summary (Sonnet 5) | 84.5% | 8.8 s | $0.019 | 0 | 33% |

When almost everything is relevant, jev-compactor refuses to hit the budget rather than drop
evidence: the goal-path and code pins alone exceed 4,000 tokens on these fixtures, and the report
says so. Truncation hits the budget and loses a third of the evidence; the summary loses two thirds.

## What this does and does not show

- The transcripts are synthetic and in the repo so the numbers are reproducible; they are two
  sessions, not a survey of your agent. Drop your own transcripts (Claude Code `.jsonl`,
  fast-jev-compaction JSON, or any messages JSON) into `packages/bench/local/` and re-run.
- Each port models one compaction pass over a bare transcript. The products also re-inject
  instruction files, memory and tool state that a transcript does not contain, so their real
  sessions keep more than these rows show — but not more of the conversation.
- Ports marked approximate substitute a model or omit a product-specific preamble; the header of
  each file says exactly what. Corrections welcome as pull requests with the upstream line cited.
- Token counts are estimates (2.5 chars/token) applied identically to every arm; costs are the
  providers' own figures.

## Reproduce

```sh
pnpm install && pnpm --filter jev-compactor build
cd packages/bench
# the product matrix (needs TYPESAFE_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY in .env.local; ≈ $0.6)
pnpm exec tsx src/run.ts fixtures/long-noisy-openai.json --max-tokens 6000 \
  --baseline baselines/truncate.mjs --baseline baselines/ai-sdk-prune.mjs --baseline baselines/claude-api-compaction.mjs \
  --baseline baselines/codex-cli.mjs --baseline baselines/gemini-cli.mjs --baseline baselines/grok-build.mjs \
  --baseline baselines/opencode.mjs --baseline baselines/langchain-summarization.mjs --baseline baselines/hermes.mjs \
  --baseline baselines/aider.mjs --baseline baselines/goose.mjs --baseline baselines/anthropic.mjs \
  --must-contain OPS-2291 --must-contain API-1187 --must-contain "duplicate idempotency key" --must-contain "migration freeze"
# the real Anthropic threshold compaction (≥ 50k real input tokens; ≈ $0.15)
pnpm exec tsx src/run.ts fixtures/long-noisy-openai-55k.json --max-tokens 20000 --baseline baselines/claude-api-compaction.mjs \
  --must-contain OPS-2291 --must-contain API-1187 --must-contain "duplicate idempotency key" --must-contain "migration freeze"
# jev-compactor's own spread
node scripts/determinism.mjs fixtures/long-noisy-openai.json --runs 5 --max-tokens 6000 [--votes 3]
```
