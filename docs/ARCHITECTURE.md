# jev-compactor — architecture

Status: v0 design, 2026-09-18. This is the Phase 1 deliverable of `docs/PRODUCT.md`: the
open-source core. Read `docs/JEV-API.md` first; every constraint below traces to a verified Jev fact.

## The one rule

**Jev judges relevance. Code decides structure.** Jev answers one bounded question per message
("does this stay in working memory for `goal`?"). Everything that must be *guaranteed* — API message
validity, code fidelity, dedup, token budgets, safety blocks — is deterministic TypeScript that runs
whether or not Jev is available or right.

## Pipeline: `compact(messages, options) → CompactionResult`

```
 originals ──► 1 normalize ──► 2 pre-pass (code) ──► 3 windows ──► 4 fan-out (Jev, parallel)
                                                                          │
 originals ◄── 7 report ◄──── 6 reassemble (code) ◄── 5 decide (code) ◄──┘
```

1. **Normalize.** Accept OpenAI chat messages, Anthropic messages, LangChain-style `{type|role,
   content}`, or plain `{role, content}`. Produce `Frame[]` — `{index, role, kind, text, tokens,
   paths, toolCallId?, hash}` where `kind ∈ system|user|assistant|tool_call|tool_result`. `text` is a
   flattened, Jev-facing excerpt; **the original object is never touched** and is referenced only by
   `index`. A `tool_call` and its `tool_result`(s) form one **unit** and are always kept or dropped
   together.
2. **Deterministic pre-pass.** Runs before any network call, in this order:
   - **Pins** (never dropped): every `system` message; the last `keepRecent` units (default 4);
     units whose text mentions a file path, identifier, or URL that the `goal` mentions (this is what
     protects the `cat src/auth.ts` evidence Jev voted to drop, see JEV-API.md); units containing
     fenced code blocks or diffs newer than `pinCodeWithin` units (default 12); `pin: true` frames.
   - **Dedup**: exact-hash duplicate units → keep the last occurrence, drop the rest with reason
     `duplicate`. Jev never sees them (counting/dedup is a documented Jev weakness).
   - **Regex foreman**: a fixed list of destructive/exfiltrating patterns (`rm -rf`, `git push
     --force`, `git reset --hard`, `DROP TABLE|DATABASE`, `mkfs`, `dd of=/dev/`, `> /dev/sd`,
     `chmod -R 777`, `curl|wget … | sh`, fork bombs, `.env`/key-looking strings in outbound
     commands) flagged as `foreman:pattern` with the matching frame(s) — a hit names the message it
     is in, so a tool call is told apart from a tool result that merely quotes a command. Code-level
     and unconditional: it also runs on the calls that never reach Jev (below the `auto` trigger, or
     in the wrapper's cooldown), so safety gating holds on every call.
3. **State injection: one whole-conversation skeleton.** Jev must see the *entire* history to
   judge "superseded by a later message", so the state is never a slice. It is
   `{goal, note, messages:[{u, role, content | tool, input, result}]}` — every unit in order, with
   pinned and candidate units alike, abridged to fit `stateTokens` (default 20,000 estimated; Jev's
   hard limit is 32k for state + longest question). Abridging runs in stages, each only if the previous
   was not enough, oldest units first: (1) tool results replaced by `ok, 4213 chars (omitted)` notes
   plus a `truncateHeadChars` head; (2) unit excerpts shrunk from `excerptChars` (1,500) to 400; (3)
   old text units collapsed to one 120-character line; (4) old pinned units collapsed too (they are
   not judged, they are context); (5) the oldest candidates left out of the state entirely — an
   unjudged unit is **kept**, never silently dropped. The report records the stage reached.
   Excerpting is only for what Jev sees; the original bytes are what gets kept.
4. **Speculative fan-out.** One `choice` keep/drop question per candidate (named by unit id, referencing
   `` `messages[k]` `` in the skeleton) with the rich criteria from the probe (keep = "facts, code, file
   contents, error details or decisions the agent will still need, or the latest statement of a fact
   later messages depend on"; drop = "off-topic, pleasantry, near-duplicate, or fully superseded by a
   later message"). Rich criteria separated keep/drop at 0.96 vs ≤0.05 on the probe; bare `[KEEP, DROP]`
   was 0.78 vs ≤0.15. Plus the Foreman set, asked once per request:
   - `destructive` (noul): the **pending action** — the newest unit when the agent authored it: an
     assistant message, or a tool call with its results (`pendingUnit`) — proposes or runs a
     destructive or irreversible command. Asked as `` `messages[k]` `` so the answer is about that
     entry; when the newest message is the user's there is no pending action and the question falls
     back to "any entry", for the report only.
   - `exfiltration` (noul): the pending action (same scoping) sends secrets, keys, or private data
     to an external host.
   - `thrashing` (noul): the agent repeats a failed action without progress.
   - `goal_drift` (noul): the most recent assistant turns work on something other than `goal`.
   - `progress` (score 0–2): none / some / nearly done. Telemetry only.
   Questions are batched so that state + all questions stays under the 64k request context (measured:
   200 questions on one state in 161 ms; 42 questions on a 25k-token state in 418 ms); the same state
   is resent with every batch and batches run concurrently (`concurrency`, default 8). On HTTP 400
   `max_tokens_exceeded` the state is re-abridged one stage further and the batch retried. With
   `allowTruncate: true` a second noul per tool unit asks whether *knowing the call was made* still
   matters even if its result does not, enabling keep-call/truncate-result (off by default: v0 keeps
   the 100% fidelity promise crisp).
5. **Decide (code).** A candidate is dropped iff `P(drop) ≥ dropThreshold` (default 0.70, i.e. "when
   in doubt, keep" — matches TypeSafe's <0.5 don't-act guidance with margin). Then invariants:
   tool units stay whole; `minKeep` units survive (default 2); if the estimated result still exceeds
   `maxTokens`, run a second pass at threshold 0.50 over the remaining candidates, then drop
   judged-kept units lowest P(keep) first (oldest first on ties) until under budget (deterministic last resort, reported as
   `budget`, always with Jev's `pKeep`). Units Jev never saw (state stage 5, or a batch that
   failed) are kept — never budget-dropped — so the result may stay over budget and the report says
   why (`jev.unjudged`). Foreman: `destructive`/`exfiltration` ≥ `actionThreshold` (0.70) or a regex
   hit → the implicated frames' unit is `flagged`; ≥ `reviewThreshold` (0.35) → `review`.
   `thrashing`/`goal_drift` ≥ 0.70 → corrective system prompt.
6. **Reassemble (code).** `kept = originals.filter(byIndex)` — the returned messages are the same
   object references, byte-identical; zero string mutation of anything kept. If a corrective prompt
   is due it is appended as a `system` message (template configurable; Anthropic-shaped inputs get it
   returned separately as `systemAddendum` because their `system` is not in the array). Known
   limit: the placement follows the *message format*, not the downstream provider — OpenAI accepts a
   trailing system message, but a LangChain runnable backed by Anthropic or Gemini rejects a system
   message past index 0, and a text-only Anthropic history passed to `compact()` detects as `plain`.
   Those callers pass `format: 'anthropic'` (the note comes back as `systemAddendum`) or
   `correctivePrompts: false` and act on `report.foreman` themselves. With `safetyGating: true`, the
   result carries `blocked: true` when an action-level `destructive`/`exfiltration` finding — a regex
   hit, or Jev's noul about the pending action — implicates a frame the agent authored in the
   **pending action** (`actionIndices(pendingUnit(units))`: its assistant text or tool call, not the
   results). Nothing else blocks: not thrashing or goal drift (they steer via the corrective prompt),
   not a proposal the user already rejected, not the user's own warning, not a command a tool result
   quotes — all of those are reported and flagged. `withCompaction` then refuses the model call unless
   an `onEscrow(action)` hook resolves `approve` (local escrow; Phase 3 moves this to the Cloud
   queue); a hook that throws cannot approve, so the block stands.
7. **Report.** `CompactionReport`: per-unit `{index, decision: kept|dropped|pinned|duplicate|budget|
   flagged, pKeep, confidence, reason}`, `tokensBefore/After`, `jev: {inputTokens, latencyMs,
   windows, model, requestIds, estimatedUsd}`, `foreman: {...nouls, hits}`. This is the data the
   CLI `inspect` view and, in Phase 2, the Cloud dashboard render.

## Failure policy

- Jev unreachable, 401, 429 after retries, or timeout → **fail-open**: return the originals unchanged
  with `report.skipped = 'jev_unavailable'`. Regex foreman still runs. `failClosed: true` flips the
  policy for safety-critical deployments (throws `CompactionUnavailableError`).
- The caller's own cancellation (`options.signal`) is neither: `compact()` rejects with the abort
  error, and a wrapped target is not called.
- A question batch that fails (not a size rejection) drops out while its siblings finish; its
  candidates are kept as unjudged (never silently lost) and counted in `jev.unjudged`. The run fails
  open as a whole only when batch 0 — the one carrying the Foreman — failed, so a missing safety
  verdict never passes for a clean one, or when no batch succeeded.
- HTTP 400 `max_tokens_exceeded` re-abridges: one stage further and against a state budget cut to
  60% of what Jev refused, because Jev tokenizes CJK and dense JSON far denser than the 2.5
  chars/token estimate and the stages alone would never omit anything the estimate says fits. The
  ladder stops when a rebuild is no smaller or after eight attempts; every attempt is counted in the
  final telemetry.

## Trigger policy (`withCompaction`)

Compaction runs when `estimateTokens(messages) > maxTokens` (or `trigger: 'always'` / a predicate),
subject to `cooldownTurns` (default 1) so a loop is not re-compacted every turn. The cooldown is
tracked per conversation (keyed on its first user message), so one module-level wrapper serves many
conversations; it is armed by a run that reached Jev — a fail-open attempt included, so an
unreachable Jev is not retried with its timeouts every turn — and never by a blocked call, so a
retry of a blocked history is gated again. Skipped calls (below threshold, cooldown) still run the
regex foreman and safety gating locally. Estimation is the same 2.5 chars/token heuristic unless a
`countTokens` function is supplied (tiktoken, Anthropic's count endpoint, etc.).

## Public surface (v0)

```ts
import { compact, createCompactor, withCompaction, estimateTokens } from 'jev-compactor';

const result = await compact(messages, { goal, maxTokens: 15_000 });
result.messages; result.report; result.blocked; result.systemAddendum;

const compactor = createCompactor({ maxTokens: 15_000, safetyGating: true });   // reusable, holds the client
const agent = withCompaction(target, options);
```

`withCompaction(target, options)` inspects `target`:
- a function `(messages, ...rest) => …` → returns a function that compacts `messages` first;
- an OpenAI-style client (`chat.completions.create`) → wraps that method (`params.messages`);
- an Anthropic-style client (`messages.create`) → wraps that method (`params.messages`, `params.system`);
- a LangChain-style runnable (`invoke`) → wraps `invoke` when its input is a message array or
  `{messages}`;
- anything else → throws `UnsupportedTargetError` naming the shapes it understands.
`goal` may be a string, a function of the messages (default: the last `user` message), or omitted.

Other entry points shipped in the same package:
- **CLI** `jev-compactor compact <history.json> --goal "…" [--max-tokens N] [--json]` and
  `jev-compactor inspect <history.json>` (terminal context stream: green kept, dim strikethrough
  dropped, red flagged — the Visual Debugger's ASCII ancestor).
- **MCP server** `jev-compactor-mcp` (stdio) exposing `compact_context`, `inspect_context`,
  `check_action`.
- **LangChain**: `compact` works on LangChain message shapes; documented as a `RunnableLambda`.
  **CrewAI** is Python and out of scope for the npm package; the MCP server is the bridge.

## Unit granularity and the `===` guarantee

A unit is a *message group*: an assistant message that issues tool calls together with every tool
message that answers them (OpenAI `tool_calls` + `role: tool`; Anthropic `tool_use` blocks + the
user message carrying the `tool_result` blocks; LangChain `tool_calls` + `type: tool`). If any part of
a group must stay, the whole group stays. We never edit blocks inside a message, so every kept
message is the same object the caller passed in. This is coarser than block-level pruning (see prior
art) and is the price of a pristine, non-mutating contract.

## Prior art (surveyed 2026-09-18, see `docs/LANDSCAPE.md`)

`tamaratran/fast-jev-compaction` (MIT, 2026-09-17, 3.4k stars in a day) established Jev-scored
verbatim compaction for Claude Code transcripts: tool pairs as candidates, whole-conversation state
with staged abridging, two nouls per call (keep call / keep result), question batches under the
request limit. Our skeleton-state design converged on the same shape after our per-window design
failed the "superseded later" test. What is different here: framework-agnostic message shapes and
adapters (OpenAI, Anthropic, LangChain, plain, MCP), text units as candidates with deterministic
pins, the Foreman safety questions in the same pass with a code-level regex floor, escrow hooks, and
the report format the Cloud dashboard consumes.

## Rejected alternatives

- **LLM summarization**: lossy, slow, expensive, and the source of hallucinated paths the product
  exists to remove.
- **One Jev request per message** (the cookbook pattern): 12 calls per 12 candidates; our per-window
  fan-out is one call per ~8k tokens.
- **Judging per window of the history** (our first design): 3 parallel 8k windows answered in 294 ms vs 418 ms for one 25k request, but a window cannot see the later message that supersedes an earlier one. Correctness beat 120 ms.
- **Score instead of Choice per message**: a graded relevance number is nice for the Inspector but
  separated keep/drop less sharply on the probe (0.36 vs 0.04 keep for the same message) and would
  double question tokens; `probabilities.keep` from the Choice already gives a continuous value.
- **Letting Jev infer causal relevance** ("this file explains that error"): documented multi-hop
  weakness, verified failure; pins do it in code.
- **Rewriting kept messages** (trimming tool output in place): violates the 100% fidelity promise;
  excerpting is only for the state Jev sees.

## Testing

- **Unit** (vitest, no network): normalize adapters, pins, dedup, tool-unit pairing, windowing,
  decide invariants, reassembly identity (`===`), corrective prompt injection, fail-open.
- **Live** (`*.live.test.ts`): real `api.typesafe.ai` with `.env.local`; skipped with a loud
  message when no key is present. No mocked Jev — workspace rule.
- **Bench** (`packages/bench`, Phase 1 GTM): fixtures of real agent transcripts; report tokens
  saved, Jev cost, latency, and path-fidelity (every file path in the compacted context existed in the
  original) versus an LLM-summarization baseline.
