# jev-compactor — project instructions

Deterministic context compaction and safety gating for AI agents, powered by TypeSafe's Jev.
Founded 2026-09-18 from `docs/PRODUCT.md`. GitHub: `edwardyen724-g/jev-compactor` (the local
folder is still `~/projects/jev-context`). Per-project rules here override `~/projects/CLAUDE.md`
for this repo only.

## Read before writing code

| File | When |
|---|---|
| `HANDOVER.md` | first, in a fresh session — where we are, what is next, environment facts, gotchas |
| `docs/ARCHITECTURE.md` | always — the pipeline, invariants, public surface, rejected alternatives |
| `docs/MODULES.md` | any change under `packages/jev-compactor/src` — the per-module contracts; `src/types.ts` is frozen |
| `docs/JEV-API.md` | anything that calls Jev — verified endpoint, limits, measured latency, answer variance, weaknesses |
| `docs/DECISIONS.md` | before reversing or re-arguing a design choice — each one has its reason and date |
| `docs/BENCHMARK.md` | any change to `packages/bench` or to a number quoted in a README |
| `docs/BACKLOG.md` | picking the next thing; add new follow-ups there, not in chat |
| `docs/BUILD-PLAN.md` | what "done" means for the current phase |
| `docs/LANDSCAPE.md` | positioning, prior art, naming — read before touching the README's pitch |
| `docs/TUTORIAL.md` | the user-facing walkthrough; keep it runnable |
| `PROGRESS.md` | the dated history; append, never rewrite |

If a doc is wrong, **fix the doc in the same change**. A stale doc misleads every future session.

## Hard rules

- **Jev judges relevance; code decides structure.** A Jev answer may never break API message
  validity (tool call ↔ tool result pairs), drop a system message, or edit a kept message.
- **Kept messages are the caller's objects.** `result.messages[i] === input[j]`. No rewriting,
  trimming, re-serializing.
- **Every drop is attributable** — a reason and Jev's probability in the report. An unjudged unit
  is kept, never silently dropped.
- **Safety gating blocks the pending action only** (the agent's newest message or tool call).
  Historical proposals, the user's own warnings and commands quoted in tool results are reported
  and flagged but never block; thrashing and goal drift steer with a corrective prompt, never block.
- **Fail open by default** when Jev is unavailable; the regex floor still runs. `failClosed` exists.
- **No mocked Jev.** Unit tests cover pure code; `*.live.test.ts` hit `api.typesafe.ai` with the key
  in `.env.local` and skip loudly without it. Baselines and fixtures may be synthetic; Jev may not.
- **No invented numbers.** Every figure in a README or `docs/BENCHMARK.md` comes from a run of
  `packages/bench` whose raw JSON is committed under `docs/benchmark/`.
- **Secrets:** `TYPESAFE_API_KEY` lives in `.env.local` (gitignored, mode 600). Never print it,
  never commit it, never set the SDK to `logLevel: 'debug'` in committed code (it logs bodies).
  The CLI and MCP server redact the key from everything they print.
- **Do not read Edward's own Claude Code transcripts** (`~/.claude/projects/**/*.jsonl`); the
  auto-mode classifier blocks it and he copies what he wants into `packages/bench/local/` himself.
- **Commit messages carry no AI co-author trailer.** Edward is the author; do not add
  `Co-Authored-By` lines.
- **Ship rule:** commit and push only when Edward says so in the session (he did for Tier 1).
  `main` must stay green in CI. `npm publish` is Edward's action, never an agent's.

## Verification gates (all must pass before a push)

```
pnpm typecheck        # builds packages/jev-compactor first, then tsc across the workspace
pnpm test             # unit, no network
pnpm test:live        # real Jev; needs .env.local
pnpm lint             # biome
pnpm --filter jev-compactor build && (cd packages/jev-compactor && npm pack --dry-run)
```

## Layout

```
packages/jev-compactor/   the OSS core: lib (src/), CLI (src/cli.ts), MCP server (src/mcp.ts), fixtures/, test/
packages/bench/           benchmark harness: src/run.ts, baselines/, fixtures/ (generated), scripts/, local/ (gitignored)
apps/cloud/               Sealed Context Cloud — Phase 2, not started; do not scaffold before Phase 1's done-list is green
docs/                     spec, Jev reference, architecture, module contracts, decisions, benchmark, landscape, backlog, tutorial
.github/workflows/ci.yml  typecheck → test → lint; live tests only when the TYPESAFE_API_KEY repo secret exists
```

## Commands

```
pnpm install
pnpm --filter jev-compactor build
node packages/jev-compactor/dist/cli.mjs inspect packages/jev-compactor/fixtures/openai-tool-loop.json --goal "Fix the failing unit test in src/auth.ts"
pnpm --filter @jev-compactor/bench bench packages/bench/fixtures/long-noisy-openai.json --max-tokens 6000 --baseline baselines/truncate.mjs
```

## Sessions

`/start-session` before working here (it reads this file, `HANDOVER.md`, `docs/BACKLOG.md` and the
memory), `/end-session` before archiving the tab. Handoff docs, when one is earned, go in
`docs/handoff-<YYYY-MM-DD>-<topic>.md`.
