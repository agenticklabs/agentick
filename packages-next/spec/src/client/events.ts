/**
 * Client-bus event surfaces and shapes.
 *
 * `client.events(filter?)` exposes events ABOUT the client (connection,
 * request lifecycle, subscription lifecycle, auth state changes,
 * extension-emitted). Wire events from the server flow through
 * per-resource streams (`session(id).events()`, etc.) by default — the
 * `wireMirror()` extension republishes them under `surface: "wire"`
 * for devtools / debugging.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md §"The client-bus"
 */

import type { ClientState } from "./state.js";
import type { TransportError } from "./transport-error.js";

/**
 * Client-bus event surfaces. Open for declaration-merge extension as
 * adopters introduce new surfaces.
 */
export interface ClientEventSurfaces {
  /** Connection state transitions */
  connection: ClientConnectionEvent;
  /** RPC request lifecycle */
  request: ClientRequestEvent;
  /** Persistent subscription lifecycle (the `subscribe` RPC family) */
  subscription: ClientSubscriptionEvent;
  /** Auth state changes */
  auth: ClientAuthEvent;
  /** Wire-firehose (opt-in via `wireMirror()` extension) */
  wire: ClientWireEvent;
  /** Free-form extension events (`installer.bus` emits these) */
  extension: ClientExtensionEvent;
}

export type ClientEventSurface = keyof ClientEventSurfaces;

/**
 * Discriminated union of every event the client-bus can emit.
 */
export type ClientEvent = ClientEventSurfaces[ClientEventSurface];

export interface ClientEventBase {
  readonly clientId: string;
  readonly timestamp: number;
}

// ── connection ──────────────────────────────────────────────────────────────

export interface ClientConnectionEvent extends ClientEventBase {
  readonly surface: "connection";
  readonly phase: "transition";
  readonly from: ClientState;
  readonly to: ClientState;
}

// ── request ─────────────────────────────────────────────────────────────────

export type ClientRequestEvent =
  | (ClientEventBase & {
      readonly surface: "request";
      readonly phase: "started";
      readonly id: string;
      readonly method: string;
    })
  | (ClientEventBase & {
      readonly surface: "request";
      readonly phase: "completed";
      readonly id: string;
      readonly method: string;
      readonly durationMs: number;
    })
  | (ClientEventBase & {
      readonly surface: "request";
      readonly phase: "failed";
      readonly id: string;
      readonly method: string;
      readonly durationMs: number;
      readonly error: TransportError;
    });

// ── subscription ────────────────────────────────────────────────────────────

export type ClientSubscriptionEvent =
  | (ClientEventBase & {
      readonly surface: "subscription";
      readonly phase: "opened";
      readonly subscriptionId: string;
    })
  | (ClientEventBase & {
      readonly surface: "subscription";
      readonly phase: "closed";
      readonly subscriptionId: string;
      readonly reason: TransportError | null;
    })
  | (ClientEventBase & {
      readonly surface: "subscription";
      readonly phase: "evicted";
      readonly subscriptionId: string;
    });

// ── auth ────────────────────────────────────────────────────────────────────

export type ClientAuthEvent =
  | (ClientEventBase & { readonly surface: "auth"; readonly phase: "changed" })
  | (ClientEventBase & {
      readonly surface: "auth";
      readonly phase: "refresh-required";
      readonly reason: string;
    })
  | (ClientEventBase & {
      readonly surface: "auth";
      readonly phase: "expired";
      readonly reason: string;
      readonly renewable: boolean;
    })
  | (ClientEventBase & {
      readonly surface: "auth";
      readonly phase: "challenge";
      readonly challengeId: string;
      readonly method: string;
    });

// ── wire firehose (opt-in via wireMirror extension) ─────────────────────────

export interface ClientWireEvent extends ClientEventBase {
  readonly surface: "wire";
  readonly phase: "received";
  /** Opaque frame payload — keep typed at extension boundary. */
  readonly frame: unknown;
}

// ── extension-defined (free-form) ───────────────────────────────────────────

export interface ClientExtensionEvent extends ClientEventBase {
  readonly surface: "extension";
  readonly phase: string;
  readonly source: string;
  readonly data?: unknown;
}

/**
 * Filter for `client.events(filter?)`. Surface-scoped subscription;
 * adopters who want cursor-based resume of client-internal events get
 * it the same way as server-side events.
 */
export interface ClientEventFilter {
  readonly surface?: ClientEventSurface | readonly ClientEventSurface[];
  readonly phase?: string | readonly string[];
}
