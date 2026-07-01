/**
 * `ClientTransport` — the contract every transport implementation
 * satisfies. Lives in spec because multiple packages
 * (`@agentick/transport-in-process-next`, `@agentick/transport-websocket-next`,
 * `@agentick/transport-http-next`, `@agentick/transport-unix-socket-next`,
 * `@agentick/transport-multiplexer-next`, `@agentick/transport-mcp-client-next`)
 * implement it; the client-next package consumes it.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md §"The `ClientTransport` interface"
 */

import type { Cursor } from "../protocol/event-log.js";
import type { EventQuery } from "../data/events.js";
import type { SubscriptionScope } from "../wire/scope.js";
import type { ProgressNotificationParams, SubscriptionEventParams } from "../wire/notifications.js";
import type { WireMethod, WireParams, WireResult } from "../wire/params.js";
import type { ClientState } from "./state.js";
import type { TransportError } from "./transport-error.js";

/**
 * Event frames delivered by a subscription. Carries the cursor at the
 * event's position so subscribers can record a resume point.
 */
export interface EventFrame {
  readonly cursor: Cursor;
  readonly envelope: SubscriptionEventParams["envelope"];
}

/**
 * Frames a method-bound progress stream emits (from `_meta.progressToken`).
 * Same shape as a subscription event; we surface it through a separate
 * type so transports can distinguish the routing.
 */
export type ProgressFrame = EventFrame;

/**
 * Per-transport capability flags — exposed so selector / multiplexer /
 * extensions can ask "does this transport support X?" without
 * brittle type checks.
 */
export interface TransportCapabilities {
  /** Server can push notifications outside any specific RPC. */
  readonly bidirectional: boolean;
  /** Server can stream notifications during an open RPC (progress). */
  readonly streamingRequest: boolean;
  /** Transport self-reconnects after a drop. */
  readonly reconnectable: boolean;
  /** Future: MessagePack / CBOR binary frames. */
  readonly binaryFrames: boolean;
}

/**
 * The transport contract. Stateful — `connect()` opens the wire,
 * `close()` tears down. `request()` issues a single RPC.
 * `subscribe()` opens a persistent cursor-aware stream.
 * `progress()` consumes a method-bound progress stream initiated by
 * a `request` whose params carry `_meta.progressToken`.
 *
 * Transports MUST validate decoded JSON via `validateJsonRpcFrame` /
 * `validateJsonRpcInput` (from `@agentick/spec-next`) before treating
 * input as a typed frame.
 */
export interface ClientTransport {
  readonly id: string;
  readonly capabilities: TransportCapabilities;
  readonly state: ClientState;

  connect(): Promise<void>;
  close(): Promise<void>;

  /**
   * Issue a single JSON-RPC request. Returns the typed result or
   * throws/rejects with a `TransportError`.
   *
   * When `params._meta.progressToken` is present, the transport
   * forwards matching `notifications/progress` frames to whichever
   * progress stream the client opened via `progress(token)`.
   */
  request<M extends WireMethod>(
    method: M,
    params: WireParams<M>,
    signal?: AbortSignal,
  ): Promise<WireResult<M>>;

  /**
   * Open a persistent subscription. Returns an `AsyncIterable<EventFrame>`
   * + `close()`. The iterable terminates cleanly when:
   *   - the client calls `close()`,
   *   - the server sends `notifications/subscription/closed`,
   *   - the transport closes.
   *
   * Cursor eviction surfaces by throwing a `TransportError` of kind
   * `protocol` (with a `cursorEvicted` cause) from the next iteration
   * — loud failure per ADR 29 Phase C.
   */
  subscribe(scope: SubscriptionScope, query?: EventQuery, fromCursor?: Cursor): SubscriptionStream;

  /**
   * Open a progress stream correlated to an in-flight RPC's
   * progress token. Returns an `AsyncIterable<ProgressFrame>` that
   * completes when the underlying RPC resolves (or fails).
   */
  progress(progressToken: string): ProgressStream;

  /**
   * Observe transport state changes. Returns an unsubscribe.
   */
  onStateChange(handler: (state: ClientState) => void): () => void;

  /**
   * Observe server-emitted notifications by method name. Progress
   * (`notifications/progress`) and subscription-event frames flow
   * through their dedicated stream APIs; everything else
   * (auth/expired, capabilities/changed, adopter extension
   * notifications) surfaces through this seam.
   *
   * Multiple subscribers per method are allowed. Returns an
   * unsubscribe.
   */
  onNotification(method: string, listener: (params: unknown) => void): () => void;
}

export interface SubscriptionStream extends AsyncIterable<EventFrame> {
  readonly subscriptionId: string;
  close(): Promise<void>;
}

export interface ProgressStream extends AsyncIterable<ProgressFrame> {
  readonly progressToken: string;
  close(): Promise<void>;
}

// Re-export for adopter convenience.
export type { TransportError };
export type { ProgressNotificationParams };
