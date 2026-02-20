export interface SplitOptions {
  /** Platform character limit. */
  maxLength: number;
  /** Preferred split points, tried in order. Default: ["\n\n", "\n", ". ", " "]. */
  splitOn?: string[];
  /** Appended to all chunks except the last. Default: "". */
  continuation?: string;
}

const DEFAULT_SPLIT_POINTS = ["\n\n", "\n", ". ", " "];

/**
 * Split text to fit within a platform's character limit.
 *
 * Greedy algorithm: finds the last occurrence of the highest-priority
 * split point before maxLength, splits there, repeats for the remainder.
 */
export function splitMessage(text: string, options: SplitOptions): string[] {
  const { maxLength, continuation = "" } = options;
  const splitOn = options.splitOn ?? DEFAULT_SPLIT_POINTS;

  if (text.length <= maxLength) return [text];

  const effectiveMax = maxLength - continuation.length;
  if (effectiveMax <= 0) {
    throw new Error("maxLength must be greater than continuation length");
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

    // No split point found — hard break at effectiveMax
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
