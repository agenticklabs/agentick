/**
 * `transportError(shape)` — build a rejection that is BOTH a
 * {@link TransportError} and an `Error`.
 *
 * `TransportError` is a discriminated union of plain object shapes: callers
 * switch on `.kind`, and `isTransportError` is a structural check. That made the
 * obvious thing to reject with an object literal — which loses everything an
 * `Error` carries. No stack, so a failure has no origin. `instanceof Error` is
 * false, so every `catch (e) { if (e instanceof Error) … }` misses it. Loggers
 * that special-case errors print `[object Object]`.
 *
 * The two are not a trade-off. An `Error` subclass with the union member's own
 * fields copied onto it satisfies the structural type exactly — `.kind` still
 * discriminates, `isTransportError` still passes — and it is an `Error`. This
 * helper is the one place that assembly happens, so no transport has to
 * remember to do both.
 *
 * ```ts
 * reject(transportError({ kind: "connection", message: "connect failed", cause: err }));
 * ```
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import type { TransportError } from "@agentick/spec";

/**
 * The class behind every {@link transportError} value. Not exported for
 * construction — the factory preserves the union's per-kind required fields,
 * which a single constructor signature cannot.
 */
class TransportFailure extends Error {
  override readonly name = "TransportFailure";
}

/**
 * Wrap a {@link TransportError} shape in an `Error` carrying the same fields.
 * The return type is the INPUT type intersected with `Error`, so a
 * `{ kind: "timeout" }` in stays a `{ kind: "timeout" }` out — no widening to
 * the union, and per-kind fields (`afterMs`, `error`) survive.
 */
export function transportError<T extends TransportError>(shape: T): T & Error {
  const message = "message" in shape ? shape.message : `transport error (${shape.kind})`;
  // `message` is an own, writable property on an Error instance, so the assign
  // below carries the shape's own message when it has one.
  return Object.assign(new TransportFailure(message), shape) as T & Error;
}
