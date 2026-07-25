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
