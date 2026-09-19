# Decisions

One entry per design decision, with the reason and the date. Read before reversing one; append a
new entry (do not edit the old one) when a decision changes.

| # | Date | Decision | Why | Alternatives rejected |
|---|---|---|---|---|
| D1 | 2026-09-18 | Name the repo and package `jev-compactor` | npm name = repo name = install command; `jev-context` collided with two existing repos | `jev-context` (original) |
| D2 | 2026-09-18 | Send the **whole conversation** to Jev as one abridged skeleton state; batch questions, not history | "Superseded by a later message" needs the later message in view; 3 parallel 8k windows were 120 ms faster but blind | Per-window judging |
| D3 | 2026-09-18 | One `choice` keep/drop per unit with rich criteria | Separated keep/drop at 0.96 vs ≤0.05 on the probe; bare `[KEEP, DROP]` 0.78 vs ≤0.15; Score doubled tokens and separated less | Bare choice; Score 0–3; Noul |
| D4 | 2026-09-18 | Unit = message group (tool-call message + its result messages); never edit inside a message | Guarantees `===` identity and valid tool pairs across OpenAI/Anthropic/LangChain shapes | Block-level pruning (fast-jev-compaction style) |
| D5 | 2026-09-18 | Deterministic pins in code: system, last 4 units, goal-path, code within 12 units, caller | Jev consistently drops the tool output that *explains* an error (documented multi-hop weakness); pins protect it | Trusting Jev alone; an extra "is this evidence?" question |
| D6 | 2026-09-18 | Dedup, counting and budgets in code, never asked of Jev | Documented Jev weaknesses (counting, arithmetic) | Asking Jev "is this a duplicate?" |
| D7 | 2026-09-18 | Drop only at P(drop) ≥ 0.7; second pass 0.5; then budget | TypeSafe guidance: <0.5 don't act; "when in doubt keep" costs tokens, not evidence | Keep ≥ 0.5 (fast-jev-compaction's default) |
| D8 | 2026-09-18 | Budget pass drops **lowest P(keep) first**, oldest first on ties | The inspect view showed oldest-first discarding evidence Jev rated P(drop) = 0.19 | Oldest-first (v0 design) |
| D9 | 2026-09-18 | No truncation in v0.1; whole units only (`allowTruncate` reserved) | Keeps the "nothing kept is rewritten" promise crisp for launch | Keep-call/truncate-result middle path |
| D10 | 2026-09-18 | Fail **open** by default when Jev is unavailable; `failClosed` opt-in; regex floor always runs | An uncompacted history is a known state; a thrown error mid-loop is not | Throw and let the caller fall back |
| D11 | 2026-09-18 | Safety gating blocks the **pending action only**; history is reported/flagged, never blocking; thrashing and drift steer, never block | Review found a permablock on a proposal the user had already rejected, and blocking on thrashing contradicted the spec | Block on any action-level finding anywhere in history |
| D12 | 2026-09-18 | Foreman = Jev nouls **plus** a code-level regex floor that runs whether or not Jev answers | Adversarial tool output can steer Jev; code keeps the last word | Jev-only safety |
| D13 | 2026-09-18 | No mocked Jev anywhere in tests; live tests skip loudly without a key | Workspace rule; a mock would encode our guess of Jev's behaviour | Fake client in tests |
| D14 | 2026-09-18 | Token estimate 2.5 chars/token, re-abridge on Jev's 400 | Jev's tokenizer is not published; measured 2.2 on dense JSON, ≈4 on prose; the retry makes the estimate self-correcting | Shipping a tokenizer dependency |
| D15 | 2026-09-18 | Acknowledge `tamaratran/fast-jev-compaction` as prior art in every README | It shipped the core a day earlier; honesty costs nothing and their audience is ours | Silence |
| D16 | 2026-09-18 | Benchmark against two vanilla arms (oldest-first truncation, Claude summarization) with evidence-retention and strict path-fidelity metrics; raw JSON committed | The first fidelity metric counted prose slashes as paths; numbers must be auditable | Summarization-only comparison |
| D17 | 2026-09-18 | No AI co-author trailers on commits | Edward's request; he is the author | Harness default trailer |
| D18 | 2026-09-18 | Mermaid diagrams in the root README, numbered steps in the npm README | GitHub renders Mermaid; npm does not | ASCII-only |
| D19 | 2026-09-19 | Remove the prior-art sections and the vs-fast-jev-compaction comparison from the READMEs and llms.txt (reverses D15) | Edward's call: with the origin author's 12k-follower X audience known, an acknowledgement reads as an excuse rather than context. `docs/LANDSCAPE.md` and the design note in `docs/ARCHITECTURE.md` stay as internal engineering record. Never claim to be first. | Keeping the section for the "alternative to X" search queries |
