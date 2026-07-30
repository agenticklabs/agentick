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

import { isTransportError, type TransportError } from "@agentick/spec";

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
  // `message` is an own, writable property on an Error instance, so the assign
  // below carries the shape's own message when it has one.
  return Object.assign(new TransportFailure(describeFailure(shape)), shape) as T & Error;
}

/**
 * Coerce ANYTHING thrown into a {@link TransportError} that is also an
 * `Error`. For the paths that catch a rejection they did not construct — a
 * `fetch` that threw a `TypeError`, a socket write that threw an `EPIPE`,
 * a server rejection already shaped as a `TransportError` — and still have to
 * hand a caller something with a `kind` it can switch on.
 *
 * A value that is already both is returned untouched, so a rejection never
 * loses the stack it was born with.
 */
export function toTransportError(err: unknown): TransportError & Error {
  if (isTransportError(err)) {
    return err instanceof Error ? (err as TransportError & Error) : transportError(err);
  }
  return transportError({
    kind: "connection",
    message: err instanceof Error ? err.message : String(err),
    cause: err,
  });
}

/**
 * The `Error.message` for a failure shape.
 *
 * Every kind but `rpc` carries its own `message` and uses it verbatim. `rpc`
 * is the one whose text lives a level down, in the JSON-RPC error the SERVER
 * sent (`{ code, message, data }`) — and that text is the only part of the
 * failure a human reads. A generic `transport error (rpc)` would turn a
 * perfectly specific server answer ("prompt argument 'topic' is required")
 * into an unactionable one at exactly the moment someone is reading a console,
 * so the server's message leads and the code trails it for correlation.
 *
 * The structured payload is untouched: `err.error.code`, `err.error.message`
 * and `err.error.data` all remain on the rejection, and `@agentick/client-core`
 * still rehydrates a typed `AgentickError` out of `error.data` when the server
 * stamped one.
 */
function describeFailure(shape: TransportError): string {
  if ("message" in shape) return shape.message;
  const { code, message } = shape.error;
  return message ? `${message} (rpc error ${code})` : `rpc error ${code}`;
}
