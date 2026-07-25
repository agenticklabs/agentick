/**
 * `TransportError` — the typed failure channel for transports and
 * client RPC operations.
 *
 * Distinct from `JsonRpcError` (which is a wire-level error structure
 * inside a response envelope). `TransportError` is the JS-level error
 * type thrown / returned when transport operations fail.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import type { JsonRpcError } from "../wire/json-rpc.js";

export type TransportError =
  | { readonly kind: "connection"; readonly message: string; readonly cause?: unknown }
  | { readonly kind: "timeout"; readonly message: string; readonly afterMs: number }
  | { readonly kind: "cancelled"; readonly message: string }
  | { readonly kind: "protocol"; readonly message: string; readonly cause?: unknown }
  | { readonly kind: "rpc"; readonly error: JsonRpcError }
  | { readonly kind: "closed"; readonly message: string };

export function isTransportError(e: unknown): e is TransportError {
  return (
    typeof e === "object" &&
    e !== null &&
    "kind" in e &&
    typeof (e as { kind: unknown }).kind === "string" &&
    ["connection", "timeout", "cancelled", "protocol", "rpc", "closed"].includes(
      (e as { kind: string }).kind,
    )
  );
}
