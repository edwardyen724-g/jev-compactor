# Contributing to jev-compactor

Small, inspectable changes. For anything beyond a bug fix or a doc change, open an issue first so
the design can be agreed before the code is written.

## Setup

- Node ≥ 20 (CI runs 22) and pnpm 11 (`packageManager` in `package.json`; `corepack enable` picks
  it up).
- `pnpm install`
- `cp .env.example .env.local` and set `TYPESAFE_API_KEY` only if you will run the live tests, the
  CLI or the benchmark. `.env.local` is gitignored; never commit it.

## Checks (what CI runs)

| Command | What it does |
|---|---|
| `pnpm typecheck` | builds `packages/jev-compactor` with tsdown, then `tsc --noEmit` in every package |
| `pnpm test` | unit tests (vitest), no network; `*.live.test.ts` files are excluded |
| `pnpm test:live` | the live suite against `api.typesafe.ai`; needs `TYPESAFE_API_KEY`, sends the fixture transcripts to TypeSafe, and costs a fraction of a cent per run |
| `pnpm lint` / `pnpm lint:fix` | Biome |

`.github/workflows/ci.yml` runs typecheck, test and lint on every push to `main` and every pull
request; the live suite runs only when the repository secret `TYPESAFE_API_KEY` is set. Run the
first three locally before pushing; run the live suite when you touch `jev.ts`, `skeleton.ts`,
`engine.ts`, the CLI or the MCP server.

## The contract a change must not break

- Kept messages are the caller's own objects: `result.messages[i] === messages[j]`. Nothing kept is
  ever rewritten.
- A tool call is never separated from its result; system messages are never dropped.
- Every drop carries a reason and a probability in the report.
- When Jev is unreachable the input comes back unchanged with `report.skipped = 'jev_unavailable'`,
  unless `failClosed` is set; the regex Foreman still runs.
- The CLI and the MCP server scrub the API key from everything they print.

The tests for these live in `packages/jev-compactor/test/` (`normalize`, `prepass`, `skeleton`,
`decide`, `engine`, `with-compaction`, `cli`, `mcp`, plus the `.live` variants). A change to the
decision logic should come with a test that shows the report before and after.

## Adding a fixture

- Library fixtures: `packages/jev-compactor/fixtures/*.json` hold the same story in the `openai`,
  `anthropic`, `langchain` and `plain` formats. A new message shape needs a fixture there and a
  `normalize` test.
- Benchmark fixtures: `packages/bench/fixtures/`. `gen-long.mjs` generates `long-noisy-openai.json`
  deterministically; regenerate rather than hand-edit it.
- Real transcripts go in `packages/bench/local/` (gitignored) and never in a pull request. No real
  file paths, keys, customer data or someone else's chat in a fixture.

## Changing the benchmark

Re-run the commands under "Reproduce" in `docs/BENCHMARK.md` and update the numbers and the date in
`docs/BENCHMARK.md` and the root README together. Never change one without the other.

## Pull requests

- One change per pull request.
- Say what you ran (`pnpm typecheck && pnpm test && pnpm lint`, and `pnpm test:live` if relevant).
- Keep the package README in sync with any option, CLI flag or MCP tool you add: its Options table
  is the reference.
- Be direct and civil; the maintainer is one person and reviews in batches.
