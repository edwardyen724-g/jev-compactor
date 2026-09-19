# Jev / TypeSafe API reference (as verified 2026-09-18)

Everything below was read from https://docs.typesafe.ai, the `@typesafe-ai/sdk` 0.6.0 type
declarations, or measured live with this repo's key. Re-verify against `docs.typesafe.ai/llms.txt`
before relying on a number that matters; TypeSafe says rate limits "adjust dynamically".

## What Jev is

A **System One model**: it does not generate text. You send a `state` (string, JSON object, or
array of text) plus named **questions**; it returns typed, calibrated answers. Every question is
evaluated **in parallel and in isolation** against the same state, so adding questions adds cost
only for the question's own tokens and almost no latency.

## Endpoint

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
Content-Type: application/json
{ "model": "jev-latest", "state": <string|object|array>, "questions": { "<id>": <Question>, ... } }
```

`GET /v1/models` lists models available to the account. Ours (2026-09-18): `jev-latest`
(answers as `jev-1.13.0`), `jev-preview`.

## The three primitives

| Type | Request fields | Answer fields |
|---|---|---|
| `noul` | `instructions?`, `criteria?: {true?, false?}` | `noul` (P(yes), 0–1). **No `confidence` field.** |
| `choice` | `instructions?`, `criteria: {label: description\|null}` (≤255 labels) | `choice`, `probabilities{label}`, `confidence` (0–1) |
| `score` | `instructions`, `criteria: [level0, level1, ...]` (2–10 levels) | `score` (expected value, may be fractional), `legend`, `probabilities{index}`, `confidence` |

`instructions` and every description accept a string, JSON object, or array. Reference state
fields from a question with backticks and dot/bracket paths: `` Is `messages[3]` needed for `goal`? ``
(verified live: per-index questions over a `messages` array work).

`confidence` collapses the probability distribution to one number. TypeSafe's guidance: below 0.5
do not act; 0.5–0.9 act with care; above 0.9 act automatically. Destructive operations deserve
higher thresholds than read-only ones. Noul and Choice numbers are **not** comparable to each other.

## Limits and pricing

| Item | Value |
|---|---|
| Context per request | 64k tokens |
| State + longest question | **32k tokens** → HTTP 400 `{"detail":{"error_type":"max_tokens_exceeded"}}` (verified) |
| Questions per request | No documented cap; **200 questions in one call worked** (161 ms) |
| Rate limits | 250k tokens/s, 1,200 requests/min (dynamic) |
| Price | **$0.042 per million input tokens; output free** |
| Errors | 401 auth, 400/422 validation, 429 rate limit, 529 overloaded; SDK retries 408/429/5xx with backoff |

## Measured latency (from `~/projects/jev-context`, 2026-09-18, `jev-1.13.0`)

| Request | Input tokens | Latency |
|---|---|---|
| 6 messages, 9 questions | 1,130 | 231 ms |
| 6 messages, 24 questions | 2,419 | 276 ms |
| 6 messages, 200 noul questions | 5,437 | 161 ms |
| 40 messages (~55k chars of dense JSON), 42 questions | 24,885 | 418 ms |
| Same 40 messages as **3 parallel windows** (~8k tokens each) | 7.9k + 9.8k + 7.7k | **294 ms total** |

Tokenization of JSON-dense state ran at ≈2.2 characters/token; prose is nearer 4. Budget state
conservatively (≈2.5 chars/token) and split on `max_tokens_exceeded`.

Cost reality: compacting a 25k-token history cost ≈ $0.001.

**Answer stability (measured 2026-09-18):** four identical requests over a 64-message state with 37
per-unit `choice` questions returned P(keep) values that differed by up to **0.14** for the same unit
(no decision at the 0.7 threshold changed in that probe, but paired benchmark runs flipped a
threshold-adjacent unit twice in nine). TypeSafe's parallel-questions cookbook reports zero variance
on its 13-question study; expect some on large fan-outs and threshold accordingly.

## Documented weaknesses that shape our design (`docs.typesafe.ai/model-jaggedness/jev-1.13`)

- **Literal reading** of instructions: state the exact condition; no inferred intent.
- **No arithmetic, no counting, no date ordering** — do dedup, counting, thresholds in code.
- **Multi-hop reasoning underperforms.** Verified: every phrasing we tried (bare Choice, rich
  Choice, Noul, 4-level Score) voted to *drop* the `cat src/auth.ts` output that showed the cause
  of the error in the goal. Causal "this code explains that error" links are for code to protect
  (path pins, code-block pins), not for Jev to infer.
- **Large irrelevant state degrades accuracy** — send excerpts, not whole tool outputs.
- **Adversarial content in state can steer answers** — tool outputs are untrusted; a regex
  foreman runs in code regardless of what Jev says.
- **No structural invariant between Noul and Choice probabilities.**

## SDK (`@typesafe-ai/sdk` 0.6.0, Node ≥ 20, MIT, ESM + CJS)

```ts
import { TypeSafeClient, choice, noul, score } from '@typesafe-ai/sdk';
const client = new TypeSafeClient({ apiKey, baseURL?, defaultModel?, timeout? /*10s per attempt*/, retry?, fetch?, logger?, logLevel? });
const { answers, usage, model } = await client.systemOne({ state, questions, model? }, { signal?, timeout?, retry?, headers? });
const { data, requestId } = await client.systemOne(...).withResponse(); // x-typesafe-request-id
```

Env fallbacks: `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`, `TYPESAFE_LOG_LEVEL`.
Errors: `TypeSafeError` → `APIError` (`BadRequestError` 400, `AuthenticationError` 401,
`PermissionDeniedError` 403, `NotFoundError` 404, `UnprocessableEntityError` 422, `RateLimitError`
429 with `retryAfterMs`, `InternalServerError` 5xx), `APIConnectionError`, `APITimeoutError`,
`APIUserAbortError`. `logLevel: 'debug'` logs request **bodies unredacted** — never in production.
The client refuses to run in a browser unless `dangerouslyAllowBrowser`.

## Prior art in TypeSafe's cookbooks worth copying

- `cookbooks/classifying_rag_passages` — four Nouls per passage (`is_relevant`,
  `contains_answer_evidence`, `contradicts_query_premise`, `contains_prompt_injection`) with
  first-match thresholds (injection > 0.70 exclude; relevant < 0.45 exclude; evidence > 0.55 include).
- `cookbooks/llm_guardrails` — review threshold 0.35, action threshold 0.70, severity Score 0–3,
  precedence support > block > review > pass. Our Foreman uses the same two-threshold shape.
- `cookbooks/parallel_questions` — 13 questions batched vs sequential: 10× faster, 12× cheaper,
  "batching neither shifts the answer nor adds variance".
- `cookbooks/rerank_typesafe` — one Noul per (query, candidate) pair, sorted by `noul`; the cookbook
  fires one request per pair, which we replace with per-window fan-out.

## Sources

docs.typesafe.ai: `/api`, `/models`, `/primitives`, `/primitives/advanced`, `/concepts/state`,
`/patterns/fan-out`, `/confidence`, `/model-jaggedness/jev-1.13`, `/sdk/javascript`, `/llms.txt`;
`node_modules/@typesafe-ai/sdk/dist/index.d.mts`; LangChain blog "Building a harness with Jev".
