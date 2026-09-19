# Security policy

## Reporting a vulnerability

Report it privately through GitHub Security Advisories:
https://github.com/edwardyen724-g/jev-compactor/security/advisories/new

If that page is unavailable, email edwardyen724@gmail.com with "jev-compactor security" in the
subject. Do not open a public issue for a vulnerability.

This project has one maintainer. You will get an acknowledgement within a few days, not a guaranteed
response time. A fix is published to npm and noted in the GitHub release for that version.

## Supported versions

Only the latest release on npm and the `main` branch receive fixes.

## In scope

- The library, CLI and MCP server in `packages/jev-compactor`.
- The API-key scrubbing in CLI and MCP output (reports, errors and unit previews).
- The Foreman regex floor and the safety gate: a bypass of a pattern the package README documents
  (`rm -rf`, `git push --force`, `git reset --hard`, `DROP TABLE`, `curl | sh`, keys in outbound
  commands, `.env` reads) is a bug.

## What the safety gate is and is not

The regex floor is a fixed list that runs locally on every call. Jev's destructive, exfiltration,
thrashing and goal-drift findings are probabilistic and thresholded (`actionThreshold` 0.70 by
default). Together they gate a model call; they are not a sandbox. Do not rely on jev-compactor as
the only control for an agent that can execute commands or reach the network.

## Data leaves your machine

When a compaction runs, an abridged copy of the conversation — the goal and an excerpt of every
message, tool inputs and the head of tool results — is sent to `api.typesafe.ai` and judged there.
Nothing is sent when a run is skipped (below threshold, cooldown), and the regex floor runs locally.
Review your data policy and TypeSafe's before enabling compaction on private code or customer data.
The Jev client's log level is pinned to `warn` so request bodies are never logged.

## Dependencies

Runtime dependencies are `@typesafe-ai/sdk`, `@modelcontextprotocol/sdk` and `zod`. Report a
vulnerability in one of them upstream; open an advisory here if jev-compactor needs a version bump
to pick up the fix.
