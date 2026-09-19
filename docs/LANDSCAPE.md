# Landscape: Jev-based context work (surveyed 2026-09-18)

Jev (`jev-latest`) was released 2026-09-10. Within eight days GitHub holds dozens of Jev projects;
context compaction is the most crowded niche. Star counts are from `gh search repos` on 2026-09-18.

## The origin and its ports

| Repo | Stars | Created | What it is |
|---|---|---|---|
| **tamaratran/fast-jev-compaction** | 3,384 (172 forks) | 2026-09-17 | Claude Code plugin + npm lib. Jev scores every tool call/result in one request; stale ones dropped or truncated; everything kept verbatim. MIT. The reference implementation everyone ports. |
| tamaratran/jev-pruner | 15 | 2026-09-18 | Claude Code plugin: trim long Bash output with Jev before the model sees it. |
| joelhooks/pi-fast-jev-compaction, KamilPostrozny/…, QuentinDanblon/…, slandau3/pi-fast-jev | ≤4 each | 2026-09-18 | Pi ports. |
| leonaaardob/fast-dev-compaction, Wang-auspicious/codex-jev-compaction | ≤2 | 2026-09-18 | Codex ports. |
| christian-taillon/opencode-jev-compactor | — | 2026-09-18 | OpenCode v2 plugin; asks ~10 narrow questions per tool item; "affirmative evidence to discard" policy. |
| jerryfane/omp-jev-compaction, ingebyd/fast-jev-compaction-openrouter | 2 | 2026-09-18 | omp port; OpenRouter/ZDR fork. |
| kevinpita/pi-jev-context, Nyarlathoteppppp/pi-jev-context, nourhelmi/pi-jev-compaction, Shashank-H/pi-jev-context-curator | ≤2 | 2026-09-18 | Pi extensions; reversible hiding rather than deletion; keep threshold 0.8. |
| dryob/hermes-jev-context-engine | 0 | 2026-09-18 | Hermes Agent (Edward's own stack) compaction. |
| zbush/jev-context | 1 | 2026-09-17 | **Same repo name, different owner**: a Codex code-search plugin using Jev relevance filtering. |

Adjacent: y0usaf/pi-jev (tool-call gate, 68★), pi-warden on npm (Jev judges every write against
project rules), devagrawal09/jev-review (staged code review + local dashboard, 279★),
Dicklesworthstone/skillranker (50★), `@ai-sdk/typesafe-ai` (Vercel AI SDK provider),
awesome-jev lists: Anil-matcha/awesome-jev-by-typesafe (532★), cobanov/awesome-jev, AnotiaWang/awesome-jev.

## What this means for positioning

- **"First to do Jev compaction" is taken** — by a day, with 3.4k stars. Searching "jev compaction"
  will land on fast-jev-compaction for the foreseeable future. The repo was renamed to `jev-compactor` on 2026-09-18 (GitHub redirects `jev-context`); the name alone
  will not redirect that traffic.
- **Every existing project is editor-bound** (Claude Code, Pi, Codex, OpenCode, omp, Hermes) or
  transcript-shaped. None is a framework-agnostic middleware for OpenAI/Anthropic/LangChain message
  arrays with an MCP server. That is the open lane `docs/PRODUCT.md` §3 Tier 1 describes.
- **None combine compaction with safety.** The Foreman piggyback (destructive/exfiltration/thrashing
  in the same Jev pass, regex floor in code, escrow hook) is unoccupied.
- **None have a control plane.** Telemetry, the visual debugger, escrow queues (Tiers 2–3) are open.
- **Demand is proven**: dozens of repos and thousands of stars in 48 hours.

## How to actually get found

1. Ship `jev-compactor` to npm with a README whose first paragraph says what the others don't do.
2. Link fast-jev-compaction as prior art in the README (honest, and their audience is ours).
3. Submit to the three awesome-jev lists and TypeSafe's community channels.
4. Publish the Phase 1 benchmark (cost, latency, path fidelity vs summarization) as the repo's
   headline; nobody in the table above has published one.
