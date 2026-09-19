/**
 * Path fidelity: does every file path, URL, or dotted identifier mentioned in a candidate context
 * exist in the original transcript? jev-compactor keeps originals, so it should score 100% by
 * construction; a summary can invent paths. We measure both to prove the claim in PRODUCT.md §5.
 * Evidence retention: which caller-named snippets (--must-contain) survive in the output.
 */
import { type AnyMessage, normalize } from 'jev-compactor';

/**
 * Only tokens that look like real references count: a URL, a path with a file extension, or a bare
 * file name with a code/config extension. `normalize` also reports looser slash tokens (they are
 * useful for goal-path pinning), but prose like `HMAC/base64url` must not count as a hallucinated
 * path here.
 */
const REFERENCE =
  /^(https?:\/\/|(?:[\w@.-]+\/)+[\w.-]+\.\w{1,8}$|[\w-]+\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|json|ya?ml|toml|md|sql|env|txt|css|html)$)/i;

export function isReference(token: string): boolean {
  return REFERENCE.test(token);
}

export function pathsOf(messages: AnyMessage[]): Set<string> {
  const { frames } = normalize(messages, 'auto');
  return new Set(frames.flatMap((f) => f.paths).filter(isReference));
}

export function pathsOfText(text: string): Set<string> {
  return pathsOf([{ role: 'user', content: text }]);
}

export interface Fidelity {
  total: number;
  present: number;
  hallucinated: string[];
  /** present / total, 1 when total is 0. */
  ratio: number;
}

export function pathFidelity(original: AnyMessage[], candidate: AnyMessage[] | string): Fidelity {
  const truth = pathsOf(original);
  const cand = typeof candidate === 'string' ? pathsOfText(candidate) : pathsOf(candidate);
  const hallucinated = [...cand].filter((p) => !truth.has(p));
  const present = cand.size - hallucinated.length;
  return {
    total: cand.size,
    present,
    hallucinated,
    ratio: cand.size === 0 ? 1 : present / cand.size,
  };
}

/** Share of snippets found verbatim (case-sensitive) in the text; 1 when no snippets were given. */
export function retention(text: string, snippets: readonly string[]): number {
  if (snippets.length === 0) return 1;
  return snippets.filter((s) => text.includes(s)).length / snippets.length;
}

/** Flatten a message array to text for LLM baselines and retention checks. */
export function transcriptText(messages: AnyMessage[]): string {
  const { frames } = normalize(messages, 'auto');
  return frames.map((f) => `[${f.role}] ${f.text}`).join('\n\n');
}
