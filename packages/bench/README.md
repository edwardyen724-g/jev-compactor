# bench

Proves (or disproves) the Phase 1 claims in `docs/PRODUCT.md` §5: token/cost reduction and path
fidelity of `jev-compactor` versus LLM summarization, on real agent transcripts.

```sh
pnpm --filter jev-compactor build
# drop transcripts into packages/bench/local/ (gitignored): Claude Code session .jsonl files,
# fast-jev-compaction JSON, or any OpenAI/Anthropic/plain messages JSON
pnpm --filter @jev-compactor/bench bench local --max-tokens 15000 --out results/run.json
# against the two "vanilla" arms — oldest-first truncation (no key) and LLM summarization (ANTHROPIC_API_KEY):
pnpm --filter @jev-compactor/bench bench local --baseline baselines/truncate.mjs --baseline baselines/anthropic.mjs \
  --must-contain "u.session.token" --must-contain "TypeError" --out results/run.json
```

`--must-contain` names snippets the continuation must still be able to see (the bug's root cause, the
exact error); **evidence retention** is the share that survive in each arm's output. jev-compactor is
also run twice per transcript to record whether the output was identical (determinism).

Columns: tokens before/after (jev-compactor's 2.5 chars/token estimate, same for both arms), saved %,
Jev wall-clock and cost from the report, **path fidelity** = share of file paths / URLs / identifiers in
the output that exist in the original (jev-compactor should be 100% by construction; summaries can
invent paths — those are listed as `hallucinated`), and Foreman findings.

Product baselines: [`baselines/README.md`](baselines/README.md) lists one file per real agent
product's compaction mechanism (Anthropic's compaction API, Codex CLI, Gemini CLI, grok-build,
OpenCode, LangChain, Hermes, Aider, goose, Vercel AI SDK `pruneMessages`), each ported with the
upstream prompt and algorithm, plus the closed products that cannot be reproduced. Pass any of them
with `--baseline`. `fixtures/gen-long.mjs --scale <n>` grows the long fixture deterministically;
`fixtures/long-noisy-openai-55k.json` (scale 6) is large enough for Anthropic's real threshold
compaction.

Privacy: transcripts stay in `local/` and results in `results/`, both gitignored. Compaction sends an
abridged copy of each transcript to `api.typesafe.ai`; the baseline sends the full text to Anthropic.
