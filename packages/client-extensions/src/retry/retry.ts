/**
 * `retry(options)` — `ClientExtension` that wraps every `request()`
 * with exponential-backoff-with-full-jitter retry.
 *
 * Same retry family as AWS SDK retry strategies, Google Cloud SDK,
 * axios-retry, got-retry, undici-retry-fetch. Differences worth
 * noting: agentick attaches an idempotency-key on retryable
 * non-idempotent methods (`session/send`, `session/dispatch`, etc.)
 * via the MCP `_meta` slot so server-side dedup is possible.
 *
 * @verifiedBy src/__tests__/retry.spec.ts
 */

import type { ClientExtension, RequestMiddleware } from "@agentick/spec";
import { defaultIdempotencyKey, defaultIsRetryable } from "./predicates.js";

export interface RetryPolicy {
  /** Max attempts including the first call. Default 3. */
  readonly maxAttempts?: number;
  /** Initial backoff in milliseconds. Default 100. */
  readonly initialDelayMs?: number;
  /** Maximum backoff in milliseconds. Default 20_000 (matches AWS SDK default). */
  readonly maxDelayMs?: number;
  /**
   * Total deadline across all attempts (ms). Once exceeded, the next
   * attempt is suppressed and the last error is re-thrown. Default:
   * unbounded.
   */
  readonly deadlineMs?: number;
}

export interface RetryOptions extends RetryPolicy {
  /**
   * Predicate deciding whether an error is retryable. Default retries
   * on transport-layer drops + a small set of server pressure codes.
   * See `defaultIsRetryable` for the full list.
   */
  readonly isRetryable?: (err: unknown) => boolean;
  /**
   * Per-method policy overrides. Lookup is exact-match on method
   * name; falls back to the top-level options for any method not in
   * the map.
   */
  readonly perMethod?: Record<string, RetryPolicy & { isRetryable?: (err: unknown) => boolean }>;
  /**
   * Idempotency-key generator. Default emits keys for non-idempotent
   * methods (`session/send`, `app/runOnce`, etc.). Return `undefined`
   * to skip emitting a key for a given method.
   *
   * The key is attached at `params._meta.idempotencyKey` and survives
   * across retry attempts so a server with dedup support can collapse
   * duplicates.
   */
  readonly idempotencyKey?: (method: string) => string | undefined;
}

const DEFAULTS = {
  maxAttempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 20_000,
} as const;

export function retry(options: RetryOptions = {}): ClientExtension {
  const policy: Required<RetryPolicy> = {
    maxAttempts: options.maxAttempts ?? DEFAULTS.maxAttempts,
    initialDelayMs: options.initialDelayMs ?? DEFAULTS.initialDelayMs,
    maxDelayMs: options.maxDelayMs ?? DEFAULTS.maxDelayMs,
    deadlineMs: options.deadlineMs ?? Infinity,
  };
  const isRetryable = options.isRetryable ?? defaultIsRetryable;
  const idempotencyKey = options.idempotencyKey ?? defaultIdempotencyKey;
  const perMethod = options.perMethod ?? {};

  const requestMw: RequestMiddleware = async (req, next) => {
    const method = req.method;
    const override = perMethod[method];
    const effective: Required<RetryPolicy> = {
      maxAttempts: override?.maxAttempts ?? policy.maxAttempts,
      initialDelayMs: override?.initialDelayMs ?? policy.initialDelayMs,
      maxDelayMs: override?.maxDelayMs ?? policy.maxDelayMs,
      deadlineMs: override?.deadlineMs ?? policy.deadlineMs,
    };
    const effectiveIsRetryable = override?.isRetryable ?? isRetryable;

    // Allocate one idempotency-key for the whole logical call.
    const key = idempotencyKey(method);
    const requestWithKey = key !== undefined ? withIdempotencyKey(req, key) : req;

    const deadline =
      effective.deadlineMs === Infinity ? Infinity : Date.now() + effective.deadlineMs;

    let lastError: unknown;
    for (let attempt = 0; attempt < effective.maxAttempts; attempt++) {
      if (req.signal?.aborted) {
        throw { kind: "cancelled", message: "aborted before attempt" };
      }
      try {
        return await next(requestWithKey);
      } catch (err) {
        lastError = err;
        if (!effectiveIsRetryable(err)) throw err;

        const nextAttempt = attempt + 1;
        if (nextAttempt >= effective.maxAttempts) break;

        const delay = computeBackoff(nextAttempt - 1, effective);
        if (Date.now() + delay > deadline) break;

        await sleep(delay, req.signal);
      }
    }
    throw lastError;
  };

  return {
    name: "retry",
    request: requestMw,
  };
}

/**
 * Exponential backoff with full jitter per AWS Builder's Library —
 * `random_uniform(0, min(maxDelayMs, initialDelayMs * 2^attempt))`.
 */
function computeBackoff(attempt: number, p: Required<RetryPolicy>): number {
  const exp = Math.min(p.maxDelayMs, p.initialDelayMs * 2 ** attempt);
  return Math.random() * exp;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject({ kind: "cancelled", message: "aborted during backoff" });
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject({ kind: "cancelled", message: "aborted during backoff" });
    });
  });
}

/**
 * Inject `_meta.idempotencyKey` into the request params without
 * clobbering existing `_meta` fields.
 */
function withIdempotencyKey<R extends { params: unknown }>(req: R, key: string): R {
  const params = req.params as Record<string, unknown> | undefined;
  const meta = (params?._meta as Record<string, unknown> | undefined) ?? {};
  const newParams = {
    ...(params ?? {}),
    _meta: { ...meta, idempotencyKey: key },
  };
  return { ...req, params: newParams };
}
