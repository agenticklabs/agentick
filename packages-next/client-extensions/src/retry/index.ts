/**
 * `@agentick/client-extensions-next/retry` — retry extension for
 * `@agentick/client-core-next`.
 *
 * Exponential backoff with full jitter (per AWS Builder's Library,
 * "Timeouts, retries, and backoff with jitter" — Marc Brooker),
 * configurable retryable-error predicate, optional deadline budget,
 * idempotency-key propagation for non-idempotent methods.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

export { retry, type RetryOptions, type RetryPolicy } from "./retry.js";
export {
  defaultIsRetryable,
  defaultIdempotencyKey,
  generateIdempotencyKey,
  type RetryableError,
} from "./predicates.js";
