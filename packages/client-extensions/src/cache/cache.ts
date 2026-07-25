/**
 * `cache(options)` — read-through `ClientExtension`. Method-explicit-
 * allowlist by default; per-method TTL + key derivation; pluggable
 * `CacheStore` (default LRU in-memory).
 *
 * @verifiedBy src/__tests__/cache.spec.ts
 */

import type { ClientExtension, RequestMiddleware } from "@agentick/spec";
import { LruCacheStore, type CacheStore } from "./lru.js";

export interface CacheMethodPolicy {
  /** Time-to-live in milliseconds. Required — no implicit fallback. */
  readonly ttlMs: number;
  /**
   * Optional custom key derivation. Default: `JSON.stringify(params)`.
   * Adopters with non-deterministic param ordering pass a stable hash.
   */
  readonly key?: (params: unknown) => string;
}

export interface CacheOptions {
  /**
   * Methods explicitly opted into the cache. Anything NOT listed here
   * bypasses the cache entirely. Default empty (no methods cached) —
   * a deliberate choice; agentick is stateful and most methods MUST
   * NOT be cached.
   */
  readonly methods: Record<string, CacheMethodPolicy>;
  /**
   * Cache backend. Default: in-memory LRU with `maxSize: 1000`.
   */
  readonly store?: CacheStore;
}

export function cache(options: CacheOptions): ClientExtension {
  const store = options.store ?? new LruCacheStore(1000);
  const methods = options.methods;

  const requestMw: RequestMiddleware = async (req, next) => {
    const policy = methods[req.method];
    if (!policy) return next(req);

    const key = makeKey(req.method, req.params, policy);
    const cached = store.get(key);
    if (cached && cached.expiresAt > nowMs()) {
      return cached.value as never;
    }

    const result = await next(req);
    store.set(key, {
      value: result,
      expiresAt: nowMs() + policy.ttlMs,
    });
    return result;
  };

  return {
    name: "cache",
    request: requestMw,
  };
}

function makeKey(method: string, params: unknown, policy: CacheMethodPolicy): string {
  if (policy.key) return `${method}:${policy.key(params)}`;
  // Strip `_meta` before keying — caller-specific metadata (progress
  // tokens, idempotency keys, trace context) shouldn't influence the
  // cache lookup of an identical logical call.
  let stable: unknown = params;
  if (params && typeof params === "object" && !Array.isArray(params)) {
    const { _meta: _omit, ...rest } = params as Record<string, unknown> & { _meta?: unknown };
    stable = rest;
  }
  return `${method}:${JSON.stringify(stable)}`;
}

function nowMs(): number {
  return Date.now();
}
