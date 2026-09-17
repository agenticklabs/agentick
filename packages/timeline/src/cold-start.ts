/**
 * Where the prompt prefix was last rewritten anyway, derived from the log.
 *
 * A provider caches a prompt prefix for a lifetime measured from the request
 * that wrote or last read it. An execution that begins after a longer gap
 * starts on a cold cache: its prefix is written in full whatever it contains,
 * so everything before it can be reshaped at no extra cost. That point never
 * moves once it exists, which is what makes a render decision keyed to it
 * stable from tick to tick.
 */

import type { TimelineEntry } from "@agentick/spec";

/** When the model last answered — the end of the last request that touched the prefix. */
export function lastReplyAt(entries: readonly TimelineEntry[]): number | undefined {
  let at: number | undefined;
  for (const entry of entries) {
    if (entry.kind !== "message" || entry.message.role !== "assistant") continue;
    if (at === undefined || entry.message.ts > at) at = entry.message.ts;
  }
  return at;
}

/**
 * The index of the first entry of the latest execution that began more than
 * `ttlMs` after the previous reply; `undefined` when no execution did. The
 * execution begins at the user run that asked for it, so the gap is measured
 * to the request, not to the reply it produced.
 */
export function coldStart(entries: readonly TimelineEntry[], ttlMs: number): number | undefined {
  const seen = new Set<string>();
  let previousReplyAt: number | undefined;
  let cold: number | undefined;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry?.kind !== "message") continue;
    const { message } = entry;
    const executionId = message.metadata?.executionId;

    if (typeof executionId === "string" && !seen.has(executionId)) {
      seen.add(executionId);
      const start = executionStart(entries, i);
      const startedAt = (entries[start] as typeof entry).message.ts;
      if (previousReplyAt !== undefined && startedAt - previousReplyAt > ttlMs) cold = start;
    }

    if (
      message.role === "assistant" &&
      (previousReplyAt === undefined || message.ts > previousReplyAt)
    ) {
      previousReplyAt = message.ts;
    }
  }
  return cold;
}

/** The first of the unstamped user messages right before an execution's first stamped entry. */
function executionStart(entries: readonly TimelineEntry[], firstStamped: number): number {
  let start = firstStamped;
  for (let i = firstStamped - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.kind !== "message") break;
    if (entry.message.role !== "user" || entry.message.metadata?.executionId !== undefined) break;
    start = i;
  }
  return start;
}
