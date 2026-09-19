# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow semver.

## [Unreleased]

### Added

- `votes` option: ask Jev every question N times in parallel and average, to stabilise units near the
  drop threshold.
- Wiring feedback: `status(wrapped)` with live counters and the last report, `isWrapped()`, the
  `verbose` option, `selfTest()`, `jev-compactor doctor`, and the MCP `self_test` tool.

- `compact()`, `createCompactor()` and `withCompaction()` for OpenAI, Anthropic, LangChain and plain
  message arrays; kept messages are the caller's objects, tool pairs stay whole, every drop carries
  a reason and Jev's probability.
- Foreman safety gating: destructive, exfiltration, thrashing and goal-drift questions in the same
  Jev request, a regex floor in code, gating scoped to the pending action, `onEscrow`,
  `CompactionBlockedError`, corrective prompts.
- CLI `jev-compactor compact | inspect`; MCP server `jev-compactor-mcp` with `compact_context`,
  `inspect_context`, `check_action`.
- Benchmark harness (`packages/bench`) with truncation and Claude-summarization baselines;
  results in `docs/BENCHMARK.md`.
