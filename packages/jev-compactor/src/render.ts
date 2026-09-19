/**
 * Shared support for the two bins (`cli.ts`, `mcp.ts`): the `inspect` view of a `CompactionResult`
 * (one line per unit, the Foreman findings, the corrective prompt), the one-line summary the CLI
 * prints to stderr, and the small helpers both bins need (package version, error text with the API
 * key scrubbed). Pure: no I/O, styles only when asked, and the caller's messages are only read —
 * they are normalized again to recover each unit's role, tools and a text preview.
 *
 * Lives in its own module because both bins run a `main()` at load, so neither can import the other.
 */
import { createRequire } from 'node:module';
import * as util from 'node:util';
import { groupUnits, normalize } from './normalize.js';
import type {
  AnyMessage,
  CompactionReport,
  CompactionResult,
  Decision,
  ForemanFinding,
  MessageFormat,
  Unit,
  UnitReport,
} from './types.js';

export interface RenderOptions {
  /** Emit ANSI styles via `util.styleText`. Plain text when false, or when styleText is missing. */
  color?: boolean;
  /** Maximum width of a unit line; the preview is truncated to fit. Default 120. */
  width?: number;
}

type StyleFormat = Parameters<typeof util.styleText>[0];

const DEFAULT_WIDTH = 120;
const MIN_WIDTH = 40;
/** A preview shorter than this is not worth the space; the line is left without one. */
const MIN_PREVIEW = 12;
const ELLIPSIS = '…';

// ───────────────────────────── helpers shared by the bins ─────────────────────────────

/** The package version, read at runtime so src and dist resolve the same `../package.json`. */
export function packageVersion(): string {
  try {
    const pkg: unknown = createRequire(import.meta.url)('../package.json');
    if (typeof pkg === 'object' && pkg !== null && 'version' in pkg) {
      const { version } = pkg as { version?: unknown };
      if (typeof version === 'string') return version;
    }
  } catch {
    // Fall through: a bin should never fail over its own version string.
  }
  return '0.0.0';
}

/** The message of any thrown value, with the API key scrubbed should it ever appear in one. */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redact(message);
}

/** Replaces every occurrence of the loaded API key with `[redacted]`. Never logs the key itself. */
export function redact(text: string): string {
  const key = process.env.TYPESAFE_API_KEY;
  if (key === undefined || key.length < 8 || !text.includes(key)) return text;
  return text.split(key).join('[redacted]');
}

/**
 * The report with `error` scrubbed (an SDK error message may echo a response body, and a gateway's
 * body may echo the request's headers). A copy: the caller's report is not touched.
 */
export function redactReport(report: CompactionReport): CompactionReport {
  if (report.error === undefined) return report;
  return { ...report, error: redact(report.error) };
}

/** The result with its report scrubbed; `messages` stays the same array of the same objects. */
export function redactResult<M extends AnyMessage>(
  result: CompactionResult<M>,
): CompactionResult<M> {
  return { ...result, report: redactReport(result.report) };
}

function formatNumber(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

// ───────────────────────────── styling ─────────────────────────────

/**
 * `util.styleText` when it exists (Node ≥ 20.12) and color is wanted; the plain text otherwise. The
 * stream check is disabled because the caller has already decided (TTY, NO_COLOR, FORCE_COLOR).
 */
function paint(enabled: boolean, format: StyleFormat, text: string): string {
  if (!enabled || text === '') return text;
  if (typeof util.styleText !== 'function') return text;
  try {
    return util.styleText(format, text, { validateStream: false });
  } catch {
    return text;
  }
}

interface Tag {
  label: string;
  style: StyleFormat;
  /** Style the whole line (dropped units are struck through), not just the tag. */
  wholeLine: boolean;
}

const TAGS: Readonly<Record<Decision, Tag>> = {
  kept: { label: 'KEEP', style: 'green', wholeLine: false },
  pinned: { label: 'PIN', style: 'blue', wholeLine: false },
  flagged: { label: 'FLAG', style: 'red', wholeLine: false },
  duplicate: { label: 'DUP', style: 'yellow', wholeLine: false },
  dropped: { label: 'DROP', style: ['dim', 'strikethrough'], wholeLine: true },
  budget: { label: 'DROP', style: ['dim', 'strikethrough'], wholeLine: true },
  truncated: { label: 'TRUNC', style: 'dim', wholeLine: false },
};

const TAG_WIDTH = Math.max(...Object.values(TAGS).map((t) => t.label.length));

// ───────────────────────────── summary ─────────────────────────────

/** `kept 12/40 messages · 15,231 → 6,004 tokens · jev 418 ms · $0.0010`, plus skip/block notes. */
export function summaryLine(result: CompactionResult): string {
  const { report } = result;
  const parts = [
    `kept ${report.messagesAfter}/${report.messagesBefore} messages`,
    `${formatNumber(report.tokensBefore)} → ${formatNumber(report.tokensAfter)} tokens`,
  ];
  if (report.jev !== undefined) {
    parts.push(
      `jev ${formatNumber(report.jev.latencyMs)} ms`,
      `$${report.jev.estimatedUsd.toFixed(4)}`,
    );
  }
  if (report.skipped !== undefined) parts.push(`skipped: ${report.skipped}`);
  if (result.blocked) parts.push('BLOCKED');
  return parts.join(' · ');
}

// ───────────────────────────── inspect view ─────────────────────────────

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1))}${ELLIPSIS}`;
}

function unitsOf(messages: readonly AnyMessage[], format: MessageFormat): Map<string, Unit> {
  const units = groupUnits(normalize([...messages], format).frames);
  return new Map(units.map((u) => [u.id, u]));
}

function kindOf(unit: Unit | undefined): string {
  if (unit === undefined) return '?';
  if (unit.isTool) {
    const names = [...new Set(unit.frames.flatMap((f) => f.toolNames))];
    return names.length > 0 ? `tool:${names.join(',')}` : 'tool';
  }
  return unit.frames[0]?.kind ?? '?';
}

function indicesOf(report: UnitReport): string {
  const first = report.indices[0];
  const last = report.indices[report.indices.length - 1];
  if (first === undefined) return '#-';
  return report.indices.length === 1 ? `#${first}` : `#${first}-${last}`;
}

/** The report's reason, with `p=` (P(drop)) added for drops whose reason lacks it. */
function reasonOf(report: UnitReport): string {
  const isDrop = report.decision === 'dropped' || report.decision === 'budget';
  if (!isDrop || report.pKeep === undefined || /\bp=/.test(report.reason)) return report.reason;
  return `${report.reason} p=${(1 - report.pKeep).toFixed(2)}`;
}

function renderFinding(finding: ForemanFinding, color: boolean): string {
  const parts = [
    finding.level.padEnd(6),
    finding.kind.padEnd(12),
    finding.source.padEnd(7),
    `p=${finding.probability.toFixed(2)}`,
  ];
  if (finding.indices.length > 0) parts.push(`#${finding.indices.join(',')}`);
  if (finding.evidence !== undefined) parts.push(finding.evidence);
  const line = `  ${parts.join('  ')}`;
  return paint(color, finding.level === 'action' ? 'red' : 'yellow', line);
}

/**
 * The corrective prompt as it was actually injected: `systemAddendum` for anthropic-shaped input,
 * otherwise the text of every message in the result that is not one of the caller's originals.
 */
function correctiveOf(
  result: CompactionResult,
  messages: readonly AnyMessage[],
): string | undefined {
  if (result.systemAddendum !== undefined) return result.systemAddendum;
  const originals = new Set<AnyMessage>(messages);
  const extras = result.messages.filter((m) => !originals.has(m));
  if (extras.length === 0) return undefined;
  return extras
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n\n');
}

/**
 * Renders the `inspect` view. `messages` must be the array `result` was produced from; it is only
 * read. One line per unit (`KEEP`, `PIN`, `FLAG`, `DUP`, `DROP` with `p=`), then the Foreman
 * findings, then the corrective prompt when one was injected.
 */
export function renderInspect(
  result: CompactionResult,
  messages: readonly AnyMessage[],
  options: RenderOptions = {},
): string {
  const color = options.color === true;
  const width = Math.max(MIN_WIDTH, options.width ?? DEFAULT_WIDTH);
  const { report } = result;
  const units = unitsOf(messages, report.format);
  const lines: string[] = [];

  // Header.
  lines.push(`goal     ${report.goal === '' ? '(none)' : oneLine(report.goal, width - 9)}`);
  lines.push(`format   ${report.format} · ${report.messagesBefore} messages · ${units.size} units`);
  lines.push(`result   ${summaryLine(result)}`);
  if (report.error !== undefined) lines.push(`error    ${redact(report.error)}`);
  if (result.blocked) lines.push(paint(color, 'red', 'blocked  yes (safety gating)'));
  lines.push('');

  // One line per unit.
  const idWidth = Math.max(2, ...report.units.map((u) => u.unit.length));
  const indexWidth = Math.max(2, ...report.units.map((u) => indicesOf(u).length));
  const kindWidth = Math.max(4, ...report.units.map((u) => kindOf(units.get(u.unit)).length));
  const tokenWidth = Math.max(1, ...report.units.map((u) => formatNumber(u.tokens).length));
  for (const unitReport of report.units) {
    const tag = TAGS[unitReport.decision];
    const unit = units.get(unitReport.unit);
    const prefix = [
      tag.label.padEnd(TAG_WIDTH),
      unitReport.unit.padEnd(idWidth),
      indicesOf(unitReport).padEnd(indexWidth),
      kindOf(unit).padEnd(kindWidth),
      `${formatNumber(unitReport.tokens).padStart(tokenWidth)} tok`,
      reasonOf(unitReport),
    ].join('  ');
    const room = width - prefix.length - 2;
    // A tool result that printed the environment would otherwise show the key in the preview.
    const preview =
      unit !== undefined && room >= MIN_PREVIEW ? oneLine(redact(unit.text), room) : '';
    const plain = preview === '' ? prefix : `${prefix}  ${preview}`;
    if (tag.wholeLine) {
      lines.push(paint(color, tag.style, plain));
    } else {
      const styledTag = paint(color, tag.style, tag.label.padEnd(TAG_WIDTH));
      lines.push(styledTag + plain.slice(TAG_WIDTH));
    }
  }
  lines.push('');

  // Foreman findings.
  if (report.foreman.length === 0) {
    lines.push('foreman  none');
  } else {
    lines.push('foreman');
    for (const finding of report.foreman) lines.push(renderFinding(finding, color));
  }

  // Corrective prompt.
  const corrective = correctiveOf(result, messages);
  if (corrective !== undefined) {
    lines.push('', 'corrective');
    for (const line of corrective.split('\n')) lines.push(`  ${line}`);
  }

  return `${lines.join('\n')}\n`;
}
