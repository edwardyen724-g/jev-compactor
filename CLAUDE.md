# jev-compactor — project instructions

Sealed Context + `jev-compactor`: deterministic context compaction and safety gating for agent
loops, powered by TypeSafe's Jev. Founded 2026-09-18. Per-project rules here override
`~/projects/CLAUDE.md` for this repo only.

## Read before writing code

| File | When |
|---|---|
| `docs/PRODUCT.md` | the founding spec (verbatim) — vision, tiers, roadmap |
| `docs/JEV-API.md` | anything that calls Jev — verified endpoint, limits, latencies, weaknesses |
| `docs/ARCHITECTURE.md` | always — the pipeline, invariants, public surface, rejected alternatives |
| `docs/BUILD-PLAN.md` | what "done" means for the current phase |

If a doc is wrong, fix the doc in the same change.

## Hard rules

- **Jev judges relevance; code decides structure.** Never let a Jev answer break API message
  validity (tool_call/tool_result pairs), drop a system message, or mutate a kept message.
- **Kept messages are the original objects.** `result.messages[i] === input[j]`. No rewriting,
  trimming, or re-serializing anything that is kept.
- **Every drop is attributable** — a reason and a probability in the report.
- **Fail open by default** when Jev is unavailable; the regex foreman still runs.
- **No mocked Jev.** Unit tests cover pure code; `*.live.test.ts` hits the real API with the key in
  `.env.local` and skips loudly without it.
- **Secrets:** `TYPESAFE_API_KEY` lives in `.env.local` (gitignored). Never print it, never set the
  SDK to `logLevel: 'debug'` in committed code (it logs bodies).
- **Don't commit or push.** Edward reviews and commits. `origin` is `github.com/edwardyen724-g/jev-compactor`.

## Layout

```
packages/jev-compactor/   the OSS core: lib + CLI + MCP server (Phase 1)
packages/bench/           benchmark harness (Phase 1 GTM)
apps/cloud/               Sealed Context Cloud (Phase 2, not started)
docs/                     spec, Jev reference, architecture, build plan
```

## Commands

```
pnpm install
pnpm typecheck && pnpm test          # unit, no network
pnpm test:live                       # hits api.typesafe.ai, needs .env.local
pnpm --filter jev-compactor build
```
