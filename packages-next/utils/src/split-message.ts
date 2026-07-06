/**
 * `splitMessage` — chunk text to fit a platform's hard character cap.
 *
 * Ported verbatim from v1's canonical `@agentick/shared/split-message`.
 * Chat surfaces impose per-message character limits (Telegram 4096,
 * SMS/iMessage segment boundaries, …). A connector splits long agent
 * output into limit-sized chunks, preferring semantic boundaries
 * (paragraph → line → sentence → word) so a split lands on a natural
 * break rather than mid-word. When no boundary exists before the cap,
 * it hard-breaks at the effective max — the limit is never exceeded.
 *
 * Greedy: for each chunk, finds the last occurrence of the
 * highest-priority split point before `maxLength`, splits there, and
 * repeats over the remainder.
 *
 * @see docs/proposals/v2/blueprint/58-connectors.md (#210)
 */

export interface SplitOptions {
  /** Platform character limit. Chunks never exceed this. */
  readonly maxLength: number;
  /** Preferred split points, tried in priority order. Default: `["\n\n", "\n", ". ", " "]`. */
  readonly splitOn?: readonly string[];
  /** Appended to every chunk except the last (e.g. `" …"`). Default: `""`. */
  readonly continuation?: string;
}

const DEFAULT_SPLIT_POINTS = ["\n\n", "\n", ". ", " "] as const;

export function splitMessage(text: string, options: SplitOptions): string[] {
  const { maxLength, continuation = "" } = options;
  const splitOn = options.splitOn ?? DEFAULT_SPLIT_POINTS;

  if (text.length <= maxLength) return [text];

  const effectiveMax = maxLength - continuation.length;
  if (effectiveMax <= 0) {
    throw new Error("splitMessage: maxLength must be greater than continuation length");
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIndex = -1;

    for (const delimiter of splitOn) {
      const idx = remaining.lastIndexOf(delimiter, effectiveMax);
      if (idx > 0) {
        splitIndex = idx + delimiter.length;
        break;
      }
    }

    // No split point found — hard break at effectiveMax.
    if (splitIndex <= 0) {
      splitIndex = effectiveMax;
    }

    const chunk = remaining.slice(0, splitIndex).trimEnd();
    chunks.push(chunk + continuation);
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
