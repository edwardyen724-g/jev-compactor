# Build plan

Phases follow `docs/PRODUCT.md` §5. Weeks count from 2026-09-18. There is no deadline (workspace
rule: building for fun); the dates are for orientation only.

## Phase 1 — `jev-compactor` OSS core (≈ through 2026-10-16)

Done means all of the following are true and Edward has reviewed and committed:

- [x] `compact()` passes the unit suite: adapters (OpenAI, Anthropic, LangChain, plain), tool-group
      units, pins, dedup, skeleton state fitting (all 5 stages), batching, decide invariants,
      reassembly identity (`===`), corrective prompt, fail-open.
- [x] `*.live.test.ts` passes against `api.typesafe.ai`: a 40-message history compacts under
      `maxTokens`, the `rm -rf` fixture is flagged, the repeated-failure fixture triggers the thrashing
      prompt, an over-limit state is re-abridged and succeeds.
- [x] `withCompaction` wraps a function, an OpenAI-shaped client, an Anthropic-shaped client, and a
      LangChain-shaped runnable (shape tests, no vendor SDKs required).
- [x] CLI: `compact` and `inspect` work on a JSON transcript; `inspect` renders green/dim/red.
- [x] MCP server starts over stdio and answers `compact_context`, `inspect_context`, `check_action`.
- [x] `pnpm build` emits ESM + CJS + d.ts; `npm pack` contents reviewed; README has the two-line
      integration, the prior-art section, and the data-leaves-your-machine notice.
- [x] `packages/bench`: five checked-in transcripts (four formats + one long noisy session) measured
      against truncation and Claude summarization — tokens saved, cost, latency, path fidelity, evidence
      retention (`docs/BENCHMARK.md`). Still open: numbers on real transcripts from Edward's own sessions.
- [ ] Publish `jev-compactor@0.1.0` to npm (Edward), submit to the awesome-jev lists. First commit pushed 2026-09-18.

## Phase 2 — Sealed Context Cloud (≈ 2026-10-17 → 2026-11-13)

Next.js app under `apps/cloud/` on Vercel (team `edwardyen724-gs-projects`), under the Sealed brand
(sealed.run). Ingest `CompactionReport`s via an API key; Context Stream / Inspector / Escrow Inbox
views from `docs/PRODUCT.md` §4; managed Jev proxy so the key never ships to clients; usage-based
billing (Stripe). Not started; do not scaffold until Phase 1's done-list is green.

## Phase 3 — Foreman enterprise layer (≈ 2026-12 → 2027-03)

Escrow queue backed by the Cloud, network-layer interception, audit log, RBAC. The local `onEscrow`
hook in Phase 1 is the seam.
