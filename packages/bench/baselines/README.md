# Baselines: what real agent products do on compaction

Each file here is one product's compaction mechanism, ported faithfully — the prompt verbatim and
the algorithm (what is kept, in which role, with which thresholds) — so "jev-compactor vs. your
framework's own compaction" is a measurable comparison rather than a comparison against a made-up
"summarize this" prompt. Every file starts with a header comment naming the upstream source, its
revision and license, whether the port is **exact** or **approximate**, and exactly what differs.

Shared plumbing lives in [`_llm.mjs`](_llm.mjs): `openrouter()` (chat completions with
`usage: { include: true }`, so cost is the provider's own figure), `anthropic()` (Messages API at
list price, with beta headers and both compaction parameters), the OpenAI→Anthropic transcript
conversion, and tool-definition stubs. Keys come from `.env.local` (`ANTHROPIC_API_KEY`,
`OPENROUTER_API_KEY`) through `loadEnvLocal`; nothing prints them.

Where the upstream product uses "the user's model", the port uses Claude Sonnet 5
(`claude-sonnet-5`, $2 / $10 per million) and says so. Where the product ships its own model, the
closest OpenRouter id is used and the substitution is named.

## The mechanisms

| file | product | fidelity | model used | what survives compaction | source |
|---|---|---|---|---|---|
| [`truncate.mjs`](truncate.mjs) | generic (no product) | — | none | first message + newest messages under budget | this repo |
| [`anthropic.mjs`](anthropic.mjs) | generic (no product) | — | claude-sonnet-5 | one continuation summary (string) | this repo |
| [`ai-sdk-prune.mjs`](ai-sdk-prune.mjs) | Vercel AI SDK `pruneMessages` | **exact** (function ported line for line; run with the configuration in the SDK's reference example: `reasoning: 'before-last-message', toolCalls: 'before-last-2-messages'`) | none | every user/system/assistant text; tool calls and results only in the last 2 messages | `ai` 7.0.107, vercel/ai@03c3e33, Apache-2.0 |
| [`claude-api-compaction.mjs`](claude-api-compaction.mjs) | Anthropic server-side compaction (the official Claude API mechanism; Claude Code's own prompt is not published) | **exact** for `threshold` (beta `compact-2026-01-12`, `compact_20260112`, trigger 50k, `pause_after_compaction`) and `on-demand` (beta `compact-2026-09-04`, `compaction: {type: "summarize"}`); **approximate** for `client` (the published default prompt run as an ordinary call, used below 55k estimated tokens) | claude-sonnet-5 | the `compaction` block's summary (string); the product sends that block in place of the history | platform.claude.com/docs/en/build-with-claude/compaction |
| [`codex-cli.mjs`](codex-cli.mjs) | OpenAI Codex CLI (`/compact`, pre-turn auto-compact) | **approximate**: prompt (byte-identical, trailing newline included) and history rebuild exact, Codex's middle-truncation marker ported; the model is the catalog default `gpt-6-astra` (first picker-visible entry; it IS on OpenRouter at $10/$50 per M), reached through OpenRouter chat completions instead of the Responses API; Codex base instructions / environment context unavailable | openai/gpt-6-astra | system message, the most recent real user messages within 20k approx tokens verbatim, `SUMMARY_PREFIX` + summary as a user message | openai/codex@78245b4, `prompts/templates/compact/*.md`, `core/src/compact.rs`, Apache-2.0 |
| [`gemini-cli.mjs`](gemini-cli.mjs) | Google Gemini CLI (`/compress`) | **approximate**: prompt (byte-identical), 30%-preserve split point, 50k tool-output budget and the two-call snapshot+probe flow ported; `gemini-3-pro-preview` (the compression alias for the default tier) is not on OpenRouter → `google/gemini-3.1-pro-preview`; Gemini `Content` represented by the fixture's OpenAI messages | google/gemini-3.1-pro-preview | system instruction, `<state_snapshot>` as a user turn, "Got it. Thanks for the additional context!", the last ~30% of history verbatim | google-gemini/gemini-cli 0.62.0-nightly.20260918.g9450ade79, `chatCompressionService.ts`, `prompts/snippets.ts`, Apache-2.0 |
| [`grok-build.mjs`](grok-build.mjs) | xAI grok-build (`/compact`, auto-compact; full-replace) | **approximate**: prompt (byte-identical), verbatim summarizer input (`compaction_verbatim_input` default true), 500-char degenerate-summary retry, output cleaning and history assembly exact; `grok-4.6` is grok-build's own catalog default, reached via OpenRouter instead of xAI's endpoint; user-info prefix, AGENTS.md and `<system-reminder>` blocks omitted (no analogue in a bare transcript) | x-ai/grok-4.6 | system message, `<user_query>` last user query, "This session is being continued…" + cleaned summary; no working tail (`for_compaction()` empties `recent_messages`) | xai-org/grok-build@e8563f8, `xai-grok-compaction/src/code_compaction/*`, `xai-chat-state/src/compaction_utils.rs`, Apache-2.0 |
| [`opencode.mjs`](opencode.mjs) | OpenCode (`/compact`, overflow auto-compact) | **approximate**: agent system prompt and `buildPrompt` template byte-identical, serialization, `select` (15k-token tail of whole user-turns; everything summarized when the conversation fits) ported, request shape as `session/llm/request.ts` builds it (system = agent prompt, `maxOutputTokens` = min(model output limit, 32k)); prune (40k protect / 20k minimum) ported but OFF because `compaction.prune` defaults to false; model is the user's | claude-sonnet-5 | system prompt, summary as an assistant message, kept tail (none when the whole conversation fits 15k), "Continue if you have next steps…" | anomalyco/opencode dev 1.18.31, `session/compaction.ts`, `core/session/compaction.ts`, `agent/prompt/compaction.txt`, MIT |
| [`langchain-summarization.mjs`](langchain-summarization.mjs) | LangChain `SummarizationMiddleware` | **approximate**: `DEFAULT_SUMMARY_PROMPT`, `keep=("messages", 20)`, safe cutoff, `trim_tokens_to_summarize=4000` (only the LAST 4k tokens of the summarized range reach the model), XML serialization ported; Python `repr()` approximated when counting; model is the user's with ChatAnthropic's default `max_tokens` (the profile's 128k for Sonnet 5) | claude-sonnet-5 | system prompt, "Here is a summary of the conversation to date:" as a human message, the last 20 messages verbatim | langchain-ai/langchain@bc16168 (1.4.2), `agents/middleware/summarization.py`, `core/messages/utils.py`, MIT |
| [`hermes.mjs`](hermes.mjs) | Hermes Agent `ContextCompressor` | **approximate**: prune/dedupe pass, head-3, token-budget tail, serialization, structured prompt (byte-identical), role selection, END marker and tool-pair sanitizer ported from the local checkout; auxiliary model is the user's; context window = what Hermes resolves for `claude-sonnet-5` (1M → threshold 500k, tail budget 100k, so at these sizes the 3-message floor sets the tail and only the dedupe pass prunes) | claude-sonnet-5 | first 3 messages (compaction note appended to the system prompt), `[CONTEXT COMPACTION — REFERENCE ONLY]` summary, protected tail verbatim (duplicate tool outputs replaced by a back-reference) | ~/.hermes/hermes-agent v0.13.0 (825bd50), `agent/context_compressor.py`, MIT |
| [`aider.mjs`](aider.mjs) | Aider `ChatSummary` | **approximate**: `summarize`/`summarize_real`/`summarize_all` and prompts (byte-identical) ported; `max_tokens` = `max_chat_history_tokens` = 8,192 (a transcript under that is returned unchanged, as aider would); `claude-sonnet-5` has no aider model settings, so its weak model is itself — Sonnet 5 is the faithful summarizer; 4 chars/token instead of litellm | claude-sonnet-5 | system prompt, "I spoke to you previously about a number of things." + summary as a user message (only USER/ASSISTANT text is summarized — aider has no tool messages), the newest turns under half the budget verbatim, trailing "Ok." | Aider-AI/aider main (2026-09-18), `aider/history.py`, `aider/prompts.py`, Apache-2.0 |
| [`goose.mjs`](goose.mjs) | Block goose (auto-compact at 80%, `/compact`) | **approximate**: `compaction.md` system prompt (byte-identical, rendered and trimmed) with the rendered conversation, `json_candidates` → JSON `StructuredSummary` → `compaction_summary.md` rendering, auto-compaction continuation assembly (tool-loop notice when the last user message is not the newest message) ported; model is the session's | claude-sonnet-5 | system prompt, rendered "# Conversation Summary" as a user message, "Your context was compacted…" assistant notice, the last text-only user message replayed | block/goose main (tree ba8ba0c), `goose-context-management/src/*`, `goose/src/context_mgmt/mod.rs`, Apache-2.0 |

### Closed: not reproducible

| product | why | documented behaviour |
|---|---|---|
| Claude Code `/compact` and auto-compact | the prompt is not published; the binary is not reverse-engineered here. The Claude API mechanism above is the closest official control. | Summarizes the conversation with the session's model (inheriting extended thinking since v2.1.198); `/compact <focus>` steers the summary; `/rewind` can summarize a range. After compaction the system prompt and output style still apply; project-root CLAUDE.md, auto memory and the plan are re-injected from disk; up to five recently read/edited files are re-read (files over 5k tokens come back as a path reference); invoked skill bodies are re-injected (5k per skill, 25k total); hook-added context is summarized with the rest. Auto-compaction fires near the model's window (about 967k on Sonnet 5's 1M window). |
| GitHub Copilot CLI `/compact` | prompt and source not published | Auto-compacts in the background at about 80% of the context window (pauses briefly at 95%); produces "a structured summary" of goals, what was done, key technical details, important files and next steps; keeps original user instructions and the current plan/to-do state plus messages that arrived during compaction; "fine-grained details … may not be included". |
| Cursor (Composer self-summarization, `/summarize`) | no prompt or algorithm published; the model is trained to summarize itself | At a fixed context-length trigger a synthetic query asks the model to summarize its own context with scratch space; the summary plus state (plan, remaining tasks, number of prior summarizations) replaces the history. Summaries average ~1k tokens vs 5k+ for a prompt-based baseline (Cursor, 2026-03-17). |
| Amp (Sourcegraph) | closed; manual only | No automatic compaction. "Handoff" extracts what matters into a new thread with a secondary model; thread references and forking cover the rest. |
| OpenAI Responses API compaction (`/v1/responses/compact`, `context_management: [{type: "compaction"}]`) | output is an opaque encrypted `compaction` item, only meaningful to OpenAI's API; needs a direct OpenAI key (not via OpenRouter) | Server-side: compacts once `compact_threshold` input tokens are reached and appends a compaction item; standalone: returns the item for the full input. Items are "opaque and not intended to be human-interpretable"; content metrics (retention, path fidelity) cannot be measured. Codex CLI uses this remote path on OpenAI models (`RemoteCompactionSupport::V2`), which is why the local Codex mechanism is the portable control. |
| xAI Responses API compaction (`POST /v1/responses/compact`) | output is one opaque `encrypted_content` blob; direct xAI key | Replaces the whole conversation with a compaction item that "preserves system prompts, attached files, prior reasoning, and a compacted record of the turns — while dropping the verbose tool output"; `usage` reports `dropped_message_count`. Not measurable for content. |

## Results

The measured matrix, the run-to-run variance and the 55k-token real-API comparison live in
[`docs/BENCHMARK.md`](../../../docs/BENCHMARK.md) (single source of truth; raw JSON under
`docs/benchmark/`). Aider's row there is its real behaviour — it does not summarize a history under
its 8,192-token limit — and the Grok/Hermes "references not in the transcript" are their own
templates' file names, not hallucinated paths.

## Reproduce

```sh
cd packages/bench
pnpm exec tsx src/run.ts fixtures/long-noisy-openai.json --max-tokens 6000 \
  --baseline baselines/truncate.mjs --baseline baselines/anthropic.mjs \
  --baseline baselines/ai-sdk-prune.mjs --baseline baselines/claude-api-compaction.mjs \
  --baseline baselines/codex-cli.mjs --baseline baselines/gemini-cli.mjs --baseline baselines/grok-build.mjs \
  --baseline baselines/opencode.mjs --baseline baselines/langchain-summarization.mjs --baseline baselines/hermes.mjs \
  --baseline baselines/aider.mjs --baseline baselines/goose.mjs \
  --must-contain OPS-2291 --must-contain API-1187 --must-contain "duplicate idempotency key" --must-contain "migration freeze" \
  --out ../../docs/benchmark/product-baselines-long-noisy.json
# the real Anthropic threshold compaction (needs >= 50k real input tokens):
pnpm exec tsx src/run.ts fixtures/long-noisy-openai-55k.json --max-tokens 20000 \
  --baseline baselines/claude-api-compaction.mjs --must-contain OPS-2291 --must-contain API-1187 \
  --must-contain "duplicate idempotency key" --must-contain "migration freeze"
# the on-demand `compaction: {type: "summarize"}` request on any size:
BENCH_CLAUDE_COMPACTION=on-demand pnpm exec tsx src/run.ts fixtures/long-noisy-openai.json --max-tokens 6000 \
  --baseline baselines/claude-api-compaction.mjs ...
```

Environment overrides: `BENCH_CLAUDE_MODEL`, `BENCH_CLAUDE_COMPACTION` (`auto` | `client` |
`threshold` | `on-demand`), `BENCH_CODEX_MODEL`, `BENCH_GEMINI_MODEL`, `BENCH_GROK_MODEL`,
`BENCH_AI_SDK_TOOLCALLS`, `BENCH_HERMES_CONTEXT`, `BENCH_OPENCODE_PRUNE=1`,
`BENCH_AIDER_MAX_HISTORY_TOKENS`.

Every port first passes the transcript through `toOpenAIShape()` (`_llm.mjs`), so the Anthropic
content-block and LangChain-typed fixtures in `packages/jev-compactor/fixtures` run through the same
code as the OpenAI-shaped ones; OpenAI/plain transcripts are handed over untouched.

Two honesty notes. Every LLM arm's numbers move between runs (models are not deterministic; the
retention of a single fact can flip). And each port models one compaction pass on a bare transcript:
the products also re-inject instructions files, memory and tool state that a transcript does not
contain, so their real sessions keep more than these rows show — but not more of the conversation.
