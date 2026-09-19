# Handover — read me first in a new session

Written 2026-09-18 at the close of the founding session. `CLAUDE.md` has the standing rules;
`PROGRESS.md` has the history; `docs/BACKLOG.md` has the queue. This file is the bridge.

## State in one paragraph

Tier 1 of `docs/PRODUCT.md` exists, is tested against the live Jev API, is benchmarked, and is
pushed to `github.com/edwardyen724-g/jev-compactor` with CI green. `packages/jev-compactor` is
publish-ready at 0.1.0 (105 kB tarball, ESM + CJS + types, MIT) but **not yet on npm** — that is
Edward's action. The package compacts OpenAI, Anthropic, LangChain and plain message arrays through
one Jev request per batch, never rewrites a kept message, gates the agent's pending action on
destructive/exfiltration findings, and emits a per-decision report. The headline benchmark, against the products' own
compaction mechanisms ported verbatim: 73% saved (53–76% across runs) with all four early facts kept
in 350 ms for $0.0004 on a 64-message session, versus 61–86% saved at $0.013–$0.099 and 1–61 s for
the model-based products, half of which lost a fact (`docs/BENCHMARK.md`).

## What exists

| Where | What | Status |
|---|---|---|
| `packages/jev-compactor/src` | 13 modules per `docs/MODULES.md`; `types.ts` frozen | 439 unit + 48 live tests green |
| `packages/jev-compactor/dist` | `index.{mjs,cjs}`, `cli.mjs`, `mcp.mjs` | built by `pnpm typecheck`/`build`; the bins bundle the library a second time (backlog) |
| `packages/bench` | runner, twelve product-mechanism baselines + truncation + generic summary, determinism probe (`--votes`), fixture generator (`--scale`) | numbers in `docs/BENCHMARK.md`, raw JSON in `docs/benchmark/` |
| `docs/` | PRODUCT (verbatim spec), JEV-API, ARCHITECTURE, MODULES, DECISIONS, BENCHMARK, LANDSCAPE, BUILD-PLAN, TUTORIAL, BACKLOG | current as of 2026-09-18 |
| GitHub | public repo, description + topics set, CI on push | 4 commits on `main`, no co-author trailers |

## What is next, in order

1. **`npm publish`** from `packages/jev-compactor` (Edward). Then add the npm badge to the README.
2. **Get found:** submit to the awesome-jev lists named in `docs/LANDSCAPE.md`; apply the SEO/AEO/GEO
   plan (FAQ, `llms.txt`, community files) if it is not already merged.
3. **Real-transcript benchmark:** Edward copies a few Claude Code `.jsonl` sessions into
   `packages/bench/local/` and runs the two commands in `docs/BENCHMARK.md`.
4. **v0.2 mechanism candidates** (see `docs/BACKLOG.md`): goal-conditioned supersession questions;
   `allowTruncate` (keep call, truncate result); the fast-jev-compaction `Message` adapter in
   `normalize.ts` (the bench converter already has it).
5. Phase 2 (Sealed Context Cloud) only after Phase 1's done-list in `docs/BUILD-PLAN.md` is fully green.

## Environment facts

- `TYPESAFE_API_KEY` is in `.env.local` at the repo root (gitignored). Verified live 2026-09-18;
  the account sees `jev-latest` (answers as `jev-1.13.0`) and `jev-preview`.
- The summarization baseline needs `ANTHROPIC_API_KEY`; the founding session sourced it from
  `~/projects/skill-as-a-service/.env.local` in a subshell. Never echo either file.
- Node 25.9 / pnpm 11.1.1 locally; CI uses Node 22 and reads the pnpm version from
  `packageManager`. TypeScript 5.9 (7.x exists; not adopted).
- The local folder is `~/projects/jev-context`; the repo was renamed to `jev-compactor`. If the
  folder is renamed, the Claude memory directory
  `~/.claude/projects/-Users-haotingyen-projects-jev-context/memory/` must move with it.
- The Vercel MCP connector is not authorized in Claude sessions; irrelevant until Phase 2.

## Gotchas learned the hard way

- **Jev's answers move between identical requests** — P(keep) drifted by up to 0.14 in probes, so a
  unit near the 0.7 threshold can flip. Documented in `docs/JEV-API.md`; raise `dropThreshold` if
  stability matters more than ratio.
- **Jev drops the tool output that explains an error** (multi-hop weakness). The goal-path pin in
  `prepass.ts` is what protects it; do not weaken it without re-running the benchmark.
- **On short, dense histories the pins alone can exceed `maxTokens`.** The compactor then stays over
  budget and says so in the report rather than dropping evidence. That is by design.
- **`rm -rf node_modules` is flagged** by the regex floor (any `rm -r`/`-f` outside temp dirs). Noisy
  but per contract; an allowlist option is in the backlog.
- **The auto-mode classifier** blocks reading Edward's Claude Code transcripts and blocks
  history rewrites/force-pushes unless Edward authorizes them explicitly in the session.
- The Anthropic adapter returns the corrective prompt as `systemAddendum` (Anthropic's `system`
  lives outside the array); a text-only Anthropic history passed to `compact()` detects as `plain`
  — pass `format: 'anthropic'` in that case.
