# Progress

Dated history of the project. Append; never rewrite.

## 2026-09-18 — founding session

- Edward pasted the product spec (`docs/PRODUCT.md`) and provided a TypeSafe API key; Jev verified
  live within the hour (231 ms for 9 questions; 200 questions in 161 ms; a 25k-token state in 418 ms;
  32k state limit confirmed by a live 400).
- Landscape survey: `tamaratran/fast-jev-compaction` (2026-09-17, 3.4k stars) had shipped the core
  mechanism a day earlier, with a dozen editor-specific ports within 24 h. Repositioned on the open
  lanes: framework-agnostic middleware, safety gating, telemetry, published benchmark
  (`docs/LANDSCAPE.md`). Repo renamed from `jev-context` to `jev-compactor`.
- Design: whole-conversation skeleton state (the per-window design lost to the "superseded by a
  later message" test), one Choice keep/drop per unit with rich criteria, Foreman nouls in the same
  request, code-level pins/dedup/regex floor, fail-open (`docs/ARCHITECTURE.md`, `docs/DECISIONS.md`).
- Build: a 12-agent workflow implemented the 13 modules against frozen contracts, integrated, then
  three adversarial reviews found 20+ real defects (safety gating skipped below the token threshold,
  cooldown armed on a blocked call, blocking on thrashing, unredacted errors, permablock on
  historical findings → gating scoped to the pending action). All fixed with regression tests.
  Hand-verified afterwards: typecheck, 439 unit, 48 live, build, lint, `npm pack`.
- Budget pass changed to drop lowest P(keep) first (was oldest-first) after the inspect view showed
  it discarding evidence Jev rated P(drop) = 0.19.
- Benchmark harness with truncation and Claude-summarization baselines; path-fidelity metric
  tightened after it counted prose slashes as paths; determinism probe added after paired runs
  differed (cause: Jev answer variance). Results in `docs/BENCHMARK.md`.
- Pushed to GitHub; CI fixed twice (pnpm version clash with `packageManager`; bench typecheck
  needs the library built first). Co-author trailers stripped from history at Edward's request.
