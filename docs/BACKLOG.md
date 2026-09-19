# Backlog

Ordered by value. Tick when done and move the line to `PROGRESS.md`. Add follow-ups here, not in chat.

## Now

- [ ] `npm publish jev-compactor@0.1.0` (Edward) and add the npm version badge to both READMEs.
- [ ] Submit to awesome-jev lists: Anil-matcha/awesome-jev-by-typesafe, cobanov/awesome-jev,
      AnotiaWang/awesome-jev; mention in TypeSafe's community channels (`docs/LANDSCAPE.md`).
- [ ] Real-transcript benchmark: Edward copies Claude Code `.jsonl` sessions into
      `packages/bench/local/` (gitignored) and runs `docs/BENCHMARK.md` § Reproduce; add a "real
      sessions" table to the benchmark doc.
- [ ] Add the `TYPESAFE_API_KEY` repository secret so CI runs the live suite (Edward's call).

## v0.2 — mechanism

- [ ] **Goal-conditioned supersession**: ask Jev, for each candidate, whether a specific later unit
      supersedes it (`does messages[j] make messages[k] unnecessary for goal?`) so every drop cites
      the message that replaced it. Nobody in the landscape does this; it would make the compaction
      core genuinely distinct from fast-jev-compaction's.
- [ ] `allowTruncate`: second noul per tool unit ("does knowing the call was made still matter?") →
      keep call, truncate result to `truncateHeadChars` + an explicit omitted-note. Off by default.
- [ ] fast-jev-compaction `Message` shape (`{role, text, toolUses, toolResults}`) as a fifth adapter
      in `normalize.ts` so their users can switch at zero cost (`packages/bench/src/convert.ts`
      already converts it).
- [ ] `patterns` allowlist helper so `rm -rf node_modules` / `rm -rf dist` stop flagging without
      writing regexes.
- [ ] Calibrate the token estimate: Jev tokenizes dense JSON at ≈2.2 chars/token vs the 2.5
      assumed; expose the measured ratio from `usage` back into `countTokens` or auto-tune per run.

## Packaging and DX

- [ ] `dist/cli.mjs` and `dist/mcp.mjs` bundle the library a second time (`render-*.mjs` chunk,
      75 kB): mark `./index` external in the bin build or import from `../dist/index.mjs`.
- [ ] Vercel AI SDK `ModelMessage` arrays work through the `plain` adapter; document it explicitly
      and add a fixture.
- [ ] Explicit LangChain example with `RunnableLambda` in `docs/TUTORIAL.md` once verified against
      an installed `@langchain/core`.
- [ ] `TYPESAFE_LOG_LEVEL` is deliberately not honored (log level pinned to `warn`); document a
      `logger` option instead if users ask.
- [ ] Social preview image for the GitHub repo (Settings › Social preview, 1280×640: the one-line
      definition, the two-line snippet, the three benchmark numbers). `llms.txt`, FAQ, community files,
      CITATION.cff and CHANGELOG landed 2026-09-18.
- [ ] After `npm publish`: `git tag v0.1.0`, `gh release create v0.1.0` (release pages are crawlable,
      tags/commits are not), set the repo homepage to the npm page, move CHANGELOG's Unreleased to 0.1.0.
- [ ] Register `jev-compactor-mcp` in the official MCP registry, then glama.ai, mcp.so, Smithery,
      PulseMCP; PR to punkpeye/awesome-mcp-servers.
- [ ] One Show HN, one Reddit post (r/LangChain, r/ClaudeAI or r/LocalLLaMA) and one X thread built
      around the benchmark sentence and the vs-fast-jev-compaction table; optionally a 2–3 minute
      `inspect` demo video titled "Reduce agent context tokens without summarization". Third-party
      pages (Reddit, YouTube) are what answer engines cite; github.com is not in their top domains.

## Phase 2 — Sealed Context Cloud (do not start before Phase 1's done-list is green)

- [ ] `apps/cloud`: Next.js on Vercel (team `edwardyen724-gs-projects`), Sealed brand; ingest
      `CompactionReport`s by API key; Context Stream / Inspector / Escrow Inbox views; managed Jev
      proxy; Stripe billing. The local `onEscrow` hook is the seam.
