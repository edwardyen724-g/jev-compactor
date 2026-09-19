/**
 * Deterministic pre-pass: pins, exact-duplicate removal and the regex Foreman floor. It runs
 * before any network call and whether or not Jev is available or right. Nothing here touches a
 * message: units are only classified by id, and the caller's objects are never read again.
 */
import { normalize } from './normalize.js';
import type { ForemanFinding, ForemanPattern, ResolvedOptions, Unit } from './types.js';

// ───────────────────────────── Foreman regex floor ─────────────────────────────
//
// Pattern hits are conservative by design. A regex cannot tell a proposal from a warning, so every
// pattern flags anything *shaped like* the command with a real target — "never run rm -rf on prod"
// is a hit, "don't run rm -rf" (no target) is not. The floor exists to be unconditional: a false
// positive costs a review, a false negative costs a repo. Jev's whole-state nouls and the escrow hook
// are where the nuance lives.

/** A shell word: stops at whitespace, command separators and redirects. */
const WORD = String.raw`[^\s;&|>]+`;
/** The rest of a shell command segment: never crosses a newline or a command separator. */
const SEG = String.raw`[^\n;&|]*`;
/** Temporary locations `rm` may clear without a finding (an optional opening quote is tolerated). */
const TMP = String.raw`["']?(?:/tmp\b|/private/tmp\b|/var/tmp\b|\$\{?TMPDIR\}?)`;
/** A temporary location that stays inside it: `/tmp/..` and `/tmp/../etc` escape and are targets. */
const TMP_SAFE = String.raw`${TMP}(?![^\s"']*\/\.\.(?![\w.-]))`;
/** What may follow a complete command word: whitespace, a quote, a separator, a closer, or the end. */
const END = String.raw`(?=[\s'"\x60;&|)\]}]|$)`;
/** Something on the line that talks to the network. */
const OUTBOUND = String.raw`(?:\b(?:curl|wget|fetch)\b|https?:)`;
/** The current line contains OUTBOUND somewhere before or after the match. */
const LINE_HAS_OUTBOUND = String.raw`(?:(?<=${OUTBOUND}[^\n]*)|(?=[^\n]*${OUTBOUND}))`;
/**
 * `api_key=…`, `"secret": "…"`, `Authorization: Bearer …` with a value of ≥ 12 non-space chars.
 * The value itself is a lookahead, so it never lands in `evidence`.
 */
const SECRET_ASSIGNMENT = String.raw`(?:api[_-]?key|secret|token|passw(?:or)?d|authorization|credentials?)[\w-]*['"]?\s*[=:]\s*['"]?(?:bearer\s+)?(?=[^\s'"\x60]{12,})`;
/** A bare `Bearer <token>` whose token looks like one (≥ 20 token-alphabet chars, not a word). */
const BARE_BEARER = String.raw`\bbearer\s+(?=[A-Za-z0-9_\-.+/=]{20,})`;
/** `.env`, `.env.local`, `.envrc` — but not `.env.example` and friends, which hold no secrets. */
const ENV_FILE = String.raw`\.env(?:rc)?\b(?!\.(?:example|sample|template|dist)\b)`;

function destructive(name: string, source: string, flags = 'i'): ForemanPattern {
  return { name, kind: 'destructive', regex: new RegExp(source, flags) };
}

function exfiltration(name: string, source: string, flags = 'i'): ForemanPattern {
  return { name, kind: 'exfiltration', regex: new RegExp(source, flags) };
}

export const DEFAULT_PATTERNS: readonly ForemanPattern[] = Object.freeze([
  // ── destructive ──
  // `rm` with a flag cluster containing r/f (or --recursive/--force) anywhere in the command (GNU rm
  // takes options after operands: `rm ./build -rf`) and at least one target that is not under /tmp
  // (`/tmp/..` escapes and counts). A target is required, which is what keeps "don't run rm -rf"
  // quiet. `git rm` only touches the index/tracked files and is recoverable, so it is excluded.
  destructive(
    'rm-recursive',
    String.raw`(?<!\bgit\s)\brm\s+(?=(?:${WORD}\s+){0,8}-(?:-recursive|-force|[a-z]*[rf])\b)(?:-\S+\s+|${TMP_SAFE}\S*\s+)*(?!${TMP_SAFE}|-)${WORD}`,
  ),
  destructive(
    'git-push-force',
    String.raw`\bgit\s+push\b(?:\s+${WORD})*?\s+(?:--force\b\S*|-[a-z]*f[a-z]*\b|\+${WORD})`,
  ),
  destructive('git-reset-hard', String.raw`\bgit\s+reset\b${SEG}?--hard\b`),
  destructive(
    'git-clean-force',
    String.raw`\bgit\s+clean\b(?:\s+${WORD})*?\s+(?:-[a-z]*f[a-z]*|--force)\b`,
  ),
  // Case-sensitive on purpose: `-D` is `--delete --force`, while `-d` refuses to delete an unmerged
  // branch and is the everyday safe form. The split forms (`-d -f`, `-df`, `--delete --force` in any
  // order or position) are the same command.
  destructive(
    'git-branch-delete-force',
    String.raw`\bgit\s+branch\b(?:(?=${SEG}\s-[a-zA-Z]*D)|(?=${SEG}\s-(?=[a-zA-Z]*d)(?=[a-zA-Z]*f)[a-zA-Z]+\b)|(?=${SEG}\s(?:-d|--delete)\b)(?=${SEG}\s(?:-f|--force)\b))${SEG}`,
    '',
  ),
  // Whole-tree discard (`git checkout -- .`, `git checkout .`, `git restore .`). A single path is
  // out of scope; `git restore --staged .` only unstages and does not match.
  destructive(
    'git-checkout-discard',
    String.raw`\bgit\s+(?:checkout|restore)\s+(?:--\s+)?\.\/?${END}`,
  ),
  destructive('sql-drop', String.raw`\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b`),
  // `TRUNCATE TABLE x` anywhere; the bare `TRUNCATE x` form only in statement position (line start,
  // or after `;`, `:`, a bracket, quote or backtick) and followed by a SQL terminator — "truncate the
  // output" and "we truncate results; then paginate" are prose.
  destructive(
    'sql-truncate',
    String.raw`\bTRUNCATE\s+TABLE\b|(?:^|(?<=[;:("'\x60]))\s*\bTRUNCATE\s+(?:ONLY\s+)?["\x60\[]?[\w.]+["\x60\]]?[ \t]*(?=;|['"\x60]|\bCASCADE\b|\bRESTART\b|\bCONTINUE\b)`,
    'im',
  ),
  // `DELETE FROM <table>` with no WHERE on the same line (a JSON-escaped `\n` counts as a line end).
  destructive(
    'sql-delete-without-where',
    String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?["\x60\[]?[\w.]+["\x60\]]?[ \t]*(?=;|\n|\\n|$|['"\x60]|\bRETURNING\b|\bLIMIT\b|\bORDER\b)`,
  ),
  // `mkfs` with a device-like operand (`/dev/…`, a variable) or a `-t` type flag; "mkfs is the tool"
  // is prose.
  destructive(
    'mkfs',
    String.raw`\bmkfs(?:\.\w+)?\s+(?=(?:${WORD}\s+){0,8}(?:/dev/|\$\{?\w|-t\b))${SEG}`,
  ),
  destructive(
    'dd-to-device',
    String.raw`\bdd\s+${SEG}\bof=/dev/(?!null\b|zero\b|stdout\b|stderr\b)`,
  ),
  destructive('redirect-to-device', String.raw`>\s*/dev/(?:sd|hd|nvme|xvd|vd|mmcblk|disk)`),
  destructive(
    'chmod-recursive-777',
    String.raw`\bchmod\s+(?=(?:${SEG}\s)?-(?:[a-z]*R|-recursive))(?=${SEG}\b0?777\b)${SEG}`,
  ),
  destructive(
    'chown-recursive',
    String.raw`\bchown\s+(?=(?:${SEG}\s)?-(?:[a-z]*R|-recursive))${SEG}`,
  ),
  destructive('fork-bomb', String.raw`:\s*\(\s*\)\s*\{\s*:`),
  destructive(
    'pipe-to-shell',
    String.raw`\b(?:curl|wget)\b[^\n|;]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:ba|z|da|k|fi)?sh\b`,
  ),
  destructive('kill-all', String.raw`\bkill\s+(?:-9|-KILL|-SIGKILL|-s\s+(?:SIG)?KILL)\s+-1\b`),
  // Only in command position (line start, after a separator/quote/backtick, or after `sudo`) AND
  // followed by what a command takes — flags, `now`, a delay, the end of the line or segment, or a
  // closing quote — so "after the reboot", "Reboot the staging box" and "Halt. Let me re-read" stay
  // quiet. A quoted bare word (`"reboot"`) still hits: that is how a JSON tool argument looks.
  destructive(
    'shutdown',
    String.raw`(?:^|[;&|\x60("'])\s*(?:sudo\s+)?(?:shutdown|reboot|halt|poweroff|init\s+[06]|systemctl\s+(?:reboot|poweroff|halt))\b(?=\s*$|\s*[;&|)\x60"']|\s+-|\s+now\b|\s+\+?\d)`,
    'im',
  ),
  destructive('terraform-destroy', String.raw`\b(?:terraform|tofu|pulumi)\s+destroy\b`),
  destructive(
    'kubectl-delete-namespace',
    String.raw`\bkubectl\s+delete\s+(?:(?:ns|namespaces?)\b|${SEG}--all\b)`,
  ),
  destructive(
    'aws-s3-rm-recursive',
    String.raw`\baws\s+s3\s+(?:rm\b${SEG}--recursive\b|rb\b${SEG}--force\b)`,
  ),

  // ── exfiltration ──
  // A secret-looking assignment on a line that also talks to the network. When the network call
  // precedes the key it is included in the match so the evidence shows where the value goes.
  exfiltration(
    'secret-in-outbound',
    String.raw`(?:${OUTBOUND}[^\n]*?)?(?:${SECRET_ASSIGNMENT}|${BARE_BEARER})${LINE_HAS_OUTBOUND}`,
  ),
  exfiltration('cat-env', String.raw`\b(?:cat|bat|less|more)\s+${SEG}${ENV_FILE}`),
  exfiltration(
    'env-piped-out',
    String.raw`\b(?:printenv|env)\b[^\n;|]*(?:\|[^\n;|]*)*?\|\s*(?:curl|wget|nc|ncat|netcat|socat)\b`,
  ),
  // A push: the `user@host:path` token is the last operand. A pull (`rsync host:/archive ./restore`)
  // brings data in and is not flagged.
  exfiltration(
    'scp-rsync-remote',
    String.raw`\b(?:scp|rsync|sftp)\s+(?:${WORD}\s+)+\w[\w.-]*@[\w.-]+:[^\s;&|"'\x60]*[ \t]*(?=$|[;&|)"'\x60])`,
    'im',
  ),
  exfiltration('base64-env', String.raw`\bbase64\b[^\n;|]*${ENV_FILE}`),
  exfiltration('reverse-shell', String.raw`\b(?:nc|ncat|netcat)\s+${SEG}-e\s|/dev/tcp/`),
]);

const EVIDENCE_CHARS = 120;

function firstMatch(regex: RegExp, text: string): string | undefined {
  // Caller-supplied patterns may carry g/y; never let their lastIndex leak between units.
  const stateful = regex.global || regex.sticky;
  if (stateful) regex.lastIndex = 0;
  const match = regex.exec(text);
  if (stateful) regex.lastIndex = 0;
  return match?.[0];
}

/**
 * One finding per (unit, pattern) whose regex matches — pinned units included, since a pinned
 * message can still propose `rm -rf`. Probability 1, action level, unconditional. `indices` names
 * the frames the pattern hit (a tool call, or a tool result that merely quotes a command), so the
 * gate can tell what the agent did from what it read; the whole unit only when the joined text
 * alone matches.
 */
export function scanPatterns(units: Unit[], patterns: readonly ForemanPattern[]): ForemanFinding[] {
  const findings: ForemanFinding[] = [];
  for (const unit of units) {
    for (const pattern of patterns) {
      const indices: number[] = [];
      let evidence: string | undefined;
      for (const frame of unit.frames) {
        const match = firstMatch(pattern.regex, frame.text);
        if (match === undefined) continue;
        indices.push(frame.index);
        evidence ??= match;
      }
      if (evidence === undefined) {
        const match = firstMatch(pattern.regex, unit.text);
        if (match === undefined) continue;
        evidence = match;
        indices.push(...unit.indices);
      }
      findings.push({
        kind: pattern.kind,
        source: 'pattern',
        probability: 1,
        level: 'action',
        indices,
        evidence: `${pattern.name}: ${evidence.slice(0, EVIDENCE_CHARS)}`,
      });
    }
  }
  return findings;
}

// ───────────────────────────── pre-pass ─────────────────────────────

export interface PrepassResult {
  /** Unit id → `pinned:system` | `pinned:caller` | `pinned:recent` | `pinned:goal-path <p>` | `pinned:code`. */
  pinned: Map<string, string>;
  /** Unit id → `duplicate of u<n>`, where `u<n>` is the later, surviving occurrence. */
  duplicates: Map<string, string>;
  /** Units that are neither pinned nor duplicates, in order: what Jev judges. */
  candidates: Unit[];
  /** Regex Foreman hits over every unit. */
  findings: ForemanFinding[];
}

/** Paths, identifiers and URLs in `goal`, extracted by the same rules as a message frame. */
function goalPaths(goal: string): string[] {
  if (goal === '') return [];
  return normalize([{ role: 'user', content: goal }], 'plain').frames[0]?.paths ?? [];
}

/**
 * The first unit path that occurs in the goal, else the first goal path that occurs in the unit
 * text; both case-insensitive. Returns the path as written on the side it was taken from.
 */
function goalPathFor(unit: Unit, goalLower: string, paths: readonly string[]): string | undefined {
  if (goalLower === '') return undefined;
  for (const frame of unit.frames) {
    for (const path of frame.paths) {
      if (goalLower.includes(path.toLowerCase())) return path;
    }
  }
  if (paths.length === 0) return undefined;
  const textLower = unit.text.toLowerCase();
  for (const path of paths) {
    if (textLower.includes(path.toLowerCase())) return path;
  }
  return undefined;
}

function unitHash(unit: Unit): string {
  return unit.frames.map((f) => f.hash).join();
}

/**
 * Pins, then dedup among the unpinned, then the regex Foreman over everything. Pin reasons are
 * assigned in priority order (system, caller, recent, goal-path, code) and the first one sticks.
 */
export function prepass(units: Unit[], goal: string, opts: ResolvedOptions): PrepassResult {
  const pinned = new Map<string, string>();
  const pin = (unit: Unit, reason: string): void => {
    if (!pinned.has(unit.id)) pinned.set(unit.id, reason);
  };

  for (const unit of units) {
    if (unit.frames.some((f) => f.kind === 'system')) pin(unit, 'pinned:system');
  }
  for (const unit of units) {
    if (unit.frames.some((f) => f.pinned)) pin(unit, 'pinned:caller');
  }
  const recentFrom = Math.max(0, units.length - Math.max(0, opts.keepRecent));
  for (const unit of units.slice(recentFrom)) pin(unit, 'pinned:recent');

  const goalLower = goal.toLowerCase();
  const paths = goalPaths(goal);
  for (const unit of units) {
    const path = goalPathFor(unit, goalLower, paths);
    if (path !== undefined) pin(unit, `pinned:goal-path ${path}`);
  }

  const codeFrom = Math.max(0, units.length - Math.max(0, opts.pinCodeWithin));
  for (const unit of units.slice(codeFrom)) {
    if (unit.frames.some((f) => f.hasCode)) pin(unit, 'pinned:code');
  }

  // Exact duplicates among the unpinned: the LAST occurrence survives, earlier copies point at it.
  const survivorByHash = new Map<string, Unit>();
  for (let i = units.length - 1; i >= 0; i--) {
    const unit = units[i];
    if (unit === undefined || pinned.has(unit.id)) continue;
    const hash = unitHash(unit);
    if (!survivorByHash.has(hash)) survivorByHash.set(hash, unit);
  }
  const duplicates = new Map<string, string>();
  for (const unit of units) {
    if (pinned.has(unit.id)) continue;
    const survivor = survivorByHash.get(unitHash(unit));
    if (survivor !== undefined && survivor.id !== unit.id) {
      duplicates.set(unit.id, `duplicate of ${survivor.id}`);
    }
  }

  const findings = scanPatterns(units, opts.patterns);
  const candidates = units.filter((u) => !pinned.has(u.id) && !duplicates.has(u.id));
  return { pinned, duplicates, candidates, findings };
}
