/**
 * `ClientProtocol` — the TypeScript contract every agentick TS client
 * implementation satisfies.
 *
 * `@agentick/client-next` ships the canonical impl. Other impls
 * (Worker-thread proxy, test mocks) conform to the same interface.
 *
 * The wire is the language-agnostic contract; this is the TypeScript
 * surface on top.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import type { Cursor } from "../protocol/event-log.js";
import type { SendInput } from "../protocol/session-harness.js";
import type { WireMethod, WireParams, WireResult } from "../wire/params.js";
import type { ClientEvent, ClientEventFilter } from "./events.js";
import type { ClientNamespaces } from "./extension.js";
import type {
  AppHandle,
  ClientSessionExecutionHandle,
  GatewayHandle,
  SessionHandle,
} from "./handles.js";
import type { ClientState } from "./state.js";
import type { ClientTransport } from "./transport.js";

/**
 * Auth surface seed. ADR 34 widens this; for now it's `unknown` so the
 * type compiles without forcing ADR 34's shape.
 */
export interface ClientAuthSurface {
  current(): unknown;
  onChange(handler: (auth: unknown) => void): () => void;
  reauthenticate(): Promise<void>;
  signOut(): Promise<void>;
}

/**
 * Core client interface. The methods every TS client implementation
 * exposes, regardless of how it talks to the gateway underneath.
 *
 * Extension-installed namespaces appear on the concrete client type
 * via `ClientNamespaces` declaration merging — see
 * `@agentick/spec-next/client/extension.ts`.
 */
export interface ClientProtocol {
  readonly id: string;
  readonly state: ClientState;
  readonly transport: ClientTransport;

  // ── connection lifecycle ────────────────────────────────────────────────
  connect(): Promise<void>;
  close(): Promise<void>;
  onStateChange(handler: (state: ClientState) => void): () => void;

  // ── generic RPC dispatch (typed via WireMethods) ───────────────────────
  /**
   * Issue a single JSON-RPC request. Pass an `AbortSignal` to cancel
   * in-flight — the client emits a `notifications/cancelled` frame to
   * the server and rejects the returned Promise with a `cancelled`
   * `TransportError`.
   */
  request<M extends WireMethod>(
    method: M,
    params: WireParams<M>,
    signal?: AbortSignal,
  ): Promise<WireResult<M>>;

  // ── resource handles ───────────────────────────────────────────────────
  gateway(): GatewayHandle;
  app(id: string): AppHandle;
  session(id: string): SessionHandle;

  // ── Vercel-style shortcuts ─────────────────────────────────────────────

  /**
   * Shortcut for `client.session(sessionId).send(input)`. Returns the
   * same `ClientSessionExecutionHandle` (AsyncIterable + `.result`).
   */
  send<P = unknown>(sessionId: string, input: SendInput<P>): ClientSessionExecutionHandle;

  // ── client-bus access ──────────────────────────────────────────────────

  /**
   * Subscribe to events ABOUT this client (connection state, request
   * lifecycle, subscription lifecycle, auth, extension-emitted).
   *
   * Wire events from the server flow through per-resource subscriptions
   * by default. The `wireMirror()` extension republishes them onto the
   * client-bus under `surface: "wire"`.
   */
  events(
    filter?: ClientEventFilter,
    fromCursor?: Cursor,
  ): AsyncIterable<ClientEvent> & { close(): Promise<void> };

  // ── auth ───────────────────────────────────────────────────────────────
  readonly auth: ClientAuthSurface;
}

/**
 * Concrete client type with extension-registered namespaces flattened
 * onto the surface via declaration merging.
 *
 * `@agentick/client-next` returns `Client` from `createClient()`. Any
 * adopter extending `ClientNamespaces` sees their namespaces typed
 * here automatically.
 */
export type Client = ClientProtocol & ClientNamespaces;
