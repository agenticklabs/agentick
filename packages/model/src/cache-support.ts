/**
 * The cache screen: what a request's declared {@link CacheBoundary}s become on
 * this target, and which are declined. A target without `explicit` support
 * caches on its own terms, so every declaration is declined with a stated
 * reason rather than sent as a marker the provider would ignore or reject.
 * With support, the provider's two constraints are applied here, once, for
 * every adapter: a longer lifetime must come before a shorter one, and only
 * `maxBoundaries` may ride one request — the earliest beyond it go.
 */

import type { CacheBoundary, ExecutionTarget, LanguageModelMessage } from "@agentick/spec";

export interface BoundaryDeclined {
  readonly messageIndex: number;
  /** The part that carried it; absent when the message itself did. */
  readonly partIndex?: number;
  readonly ttlMs: number;
  readonly reason: string;
}

export interface CacheSupportResult {
  readonly messages: readonly LanguageModelMessage[];
  readonly declined: readonly BoundaryDeclined[];
}

interface Declared {
  readonly messageIndex: number;
  readonly partIndex?: number;
  readonly boundary: CacheBoundary;
}

export function applyCacheSupport(
  messages: readonly LanguageModelMessage[],
  target: ExecutionTarget,
): CacheSupportResult {
  const declared = declaredBoundaries(messages);
  if (declared.length === 0) return { messages, declined: [] };

  const who = target.provider ?? target.kind;
  const explicit = target.capabilities?.cache?.explicit;
  const declined: BoundaryDeclined[] = [];
  const decline = (d: Declared, reason: string): void => {
    declined.push({
      messageIndex: d.messageIndex,
      ...(d.partIndex !== undefined ? { partIndex: d.partIndex } : {}),
      ttlMs: d.boundary.ttlMs,
      reason,
    });
  };

  if (explicit === undefined) {
    for (const d of declared)
      decline(d, `${who} caches on its own terms; a declared boundary has nothing to become`);
  } else {
    let shortest = Number.POSITIVE_INFINITY;
    const ordered: Declared[] = [];
    for (const d of declared) {
      if (d.boundary.ttlMs > shortest) {
        decline(
          d,
          `a longer lifetime must come before a shorter one; an earlier boundary asked for ${shortest}ms`,
        );
        continue;
      }
      shortest = d.boundary.ttlMs;
      ordered.push(d);
    }
    const max = explicit.maxBoundaries;
    if (max !== undefined && ordered.length > max) {
      for (const d of ordered.slice(0, ordered.length - max)) {
        decline(
          d,
          `${who} takes ${max} boundaries per request; the earliest beyond that are dropped`,
        );
      }
    }
  }

  if (declined.length === 0) return { messages, declined };
  const drop = new Set(declined.map((d) => `${d.messageIndex}:${d.partIndex ?? "message"}`));
  const out = messages.map((message, messageIndex) => {
    const dropMessage = drop.has(`${messageIndex}:message`);
    const content = Array.isArray(message.content)
      ? message.content.map((part, partIndex) =>
          drop.has(`${messageIndex}:${partIndex}`) ? without(part) : part,
        )
      : message.content;
    return dropMessage || content !== message.content
      ? ({ ...(dropMessage ? without(message) : message), content } as LanguageModelMessage)
      : message;
  });
  return { messages: out, declined };
}

/** Every boundary in request order; a message-level boundary sits at its last part. */
function declaredBoundaries(messages: readonly LanguageModelMessage[]): Declared[] {
  const out: Declared[] = [];
  messages.forEach((message, messageIndex) => {
    if (Array.isArray(message.content)) {
      message.content.forEach((part, partIndex) => {
        const boundary = (part as { cache?: CacheBoundary }).cache;
        if (boundary !== undefined) out.push({ messageIndex, partIndex, boundary });
      });
    }
    if (message.cache !== undefined) out.push({ messageIndex, boundary: message.cache });
  });
  return out;
}

function without<T extends { cache?: unknown }>(carrier: T): T {
  const { cache: _dropped, ...rest } = carrier;
  return rest as T;
}
