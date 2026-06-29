/**
 * `slidingWindowLimiter` — in-memory sliding-window `RateLimiter`.
 *
 * Tracks request timestamps per key in a ring; counts how many fall
 * inside the current window. Lazy cleanup — eviction happens on the
 * next call for the same key, not on a timer.
 *
 * Ported from v1 `packages/mcp/src/server/security/stages.ts`.
 *
 * **Memory characteristics.** Each tracked key holds at most `max`
 * timestamps. Total memory ~ `O(distinct_keys × max)`. For a deploy
 * with millions of keys you'd want an LRU cap; v1 + v2 leave that to
 * adopters who can wrap this limiter or supply their own.
 */

import type { McpRequestContext } from "@agentick/spec-next";

import type { OperationInfo, RateLimiter } from "../stages.js";

export interface SlidingWindowLimiterOptions {
  /** Window length in milliseconds. */
  readonly windowMs: number;
  /** Max requests per key inside the window. */
  readonly max: number;
  /**
   * Key extraction. Default: `ctx.user.id ?? ctx.connectionId` (per-
   * authenticated-user, falling back to connection identity). Adopters
   * who want per-IP or per-tool limits supply a custom function.
   */
  readonly keyFn?: (ctx: McpRequestContext, operation: OperationInfo) => string;
}

export function slidingWindowLimiter(options: SlidingWindowLimiterOptions): RateLimiter {
  const window = options.windowMs;
  const max = options.max;
  const keyFn = options.keyFn ?? defaultKeyFn;
  const buckets = new Map<string, number[]>();

  return async (ctx, operation) => {
    const key = keyFn(ctx, operation);
    const now = Date.now();
    const cutoff = now - window;

    let timestamps = buckets.get(key);
    if (!timestamps) {
      timestamps = [];
      buckets.set(key, timestamps);
    }

    // Evict stale entries — sliding-window's lazy cleanup.
    while (timestamps.length > 0 && timestamps[0]! <= cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= max) {
      const oldest = timestamps[0]!;
      const retryAfterMs = oldest + window - now;
      return { allowed: false, retryAfterMs: Math.max(0, retryAfterMs) };
    }

    timestamps.push(now);
    return { allowed: true };
  };
}

function defaultKeyFn(ctx: McpRequestContext): string {
  return ctx.mcp.user?.id ?? ctx.mcp.connectionId;
}
