/**
 * Client connection state machine.
 *
 * Mirrors `TransportState` (per-transport low-level state) but at the
 * client level — the client's `state` is the aggregate over its
 * transport(s) plus its own readiness.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import type { TransportError } from "./transport-error.js";

export type ClientState =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | { readonly kind: "failed"; readonly error: TransportError }
  | "closed";

export function isClientStateOpen(s: ClientState): boolean {
  return s === "open";
}

export function isClientStateFailed(
  s: ClientState,
): s is { kind: "failed"; error: TransportError } {
  return typeof s === "object" && s.kind === "failed";
}

/**
 * Whether the client can actually be USED — the dimension `ClientState` does
 * not cover.
 *
 * `ClientState` answers "is the wire up". That is not the same question as "is
 * this client usable", and conflating them is what produced the
 * apparently-connected-then-dead mode (#263): a gateway can accept the socket
 * before it can serve `initialize`, so the wire reads `open` while the
 * handshake — the thing that populates `capabilities` and `serverInfo` — has
 * failed. Every namespaced call then fails as "capability missing" with no
 * stated reason.
 *
 * The two dimensions are orthogonal and both are reported:
 *
 * | `state`        | `readiness`         | what it means                          |
 * | -------------- | ------------------- | -------------------------------------- |
 * | `open`         | `ready`             | usable                                 |
 * | `open`         | `handshaking`       | wire up, handshake in flight           |
 * | `open`         | `handshake-failed`  | wire up, server not answering the      |
 * |                |                     | handshake — retrying under backoff     |
 * | `reconnecting` | `idle`              | wire down; handshake owed on return    |
 *
 * A `handshake-failed` readiness is NOT terminal: the client retries under its
 * own backoff for as long as the wire stays up (`retrying: true`). It goes
 * `false` only when the retry budget is spent or retries were disabled — the
 * one case where an adopter has to act.
 */
export type ClientReadiness =
  | "idle"
  | "handshaking"
  | "ready"
  | {
      readonly kind: "handshake-failed";
      /** What the failing handshake RPC threw, verbatim. */
      readonly error: unknown;
      /** Consecutive failures on the current wire, starting at 1. */
      readonly attempts: number;
      /** Whether another attempt is scheduled. `false` means the client has stopped. */
      readonly retrying: boolean;
    };

export function isClientReady(r: ClientReadiness): boolean {
  return r === "ready";
}

export function isHandshakeFailed(
  r: ClientReadiness,
): r is { kind: "handshake-failed"; error: unknown; attempts: number; retrying: boolean } {
  return typeof r === "object" && r.kind === "handshake-failed";
}
