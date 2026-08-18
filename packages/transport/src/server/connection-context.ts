/**
 * `BaseConnectionContext` — abstract base every transport's server-side
 * per-connection adapter extends.
 *
 * Owns the shared state: subscription registry, in-flight RPC registry,
 * `closed` flag. Owns the shared logic: `dispatchInbound(frame)` routes
 * decoded JSON-RPC frames to either `notifications/cancelled` abort
 * routing or `dispatchRequest`-with-DispatchSink; `close()` iterates
 * both registries cleaning up.
 *
 * Subclasses fill in:
 *
 *   - `sendFrame(frame)` — wire-specific encoding (WS `ws.send(JSON)`,
 *     UDS `socket.write(NDJSON)`, HTTP `res.write(SSE)`)
 *   - `closeWire()` — wire-specific teardown
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import type {
  JsonRpcError,
  JsonRpcFrame,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  WireServerDescriptor,
} from "@agentick/spec";
import { ErrorCode, intersectScopes, WireRpcError, type IngressIdentity } from "@agentick/spec";

import { generateId } from "@agentick/utils";

import { dispatchRequest, type DispatchHost, type DispatchSink } from "./dispatch.js";

/**
 * Admit a client-allocated subscription id into a connection's registry, or
 * refuse it.
 *
 * The id on `sub/subscribe` is the CLIENT's, and it is what every
 * `notifications/subscription/*` frame for that subscription is keyed by. Two
 * subscriptions answering to one id on one connection is therefore not a
 * duplicate registration — it is a hijack: the second `set` re-points the
 * cleanup the connection will run, and the first subscription's frames arrive
 * at a client stream fed by a different producer. So a collision is refused
 * with the caller's own fault code rather than absorbed.
 *
 * Called synchronously inside the `sub/subscribe` handler, so `dispatchRequest`
 * maps the throw verbatim to a JSON-RPC error.
 *
 * @throws WireRpcError InvalidParams — id absent, empty, or already live here.
 */
export function admitSubscriptionId(registry: ReadonlyMap<string, unknown>, subId: string): void {
  if (typeof subId !== "string" || subId.length === 0) {
    throw new WireRpcError(
      ErrorCode.InvalidParams,
      "sub/subscribe requires a client-allocated `subscriptionId`",
    );
  }
  if (registry.has(subId)) {
    throw new WireRpcError(
      ErrorCode.InvalidParams,
      `subscriptionId "${subId}" is already open on this connection`,
      { subscriptionId: subId },
    );
  }
}

export abstract class BaseConnectionContext {
  protected readonly subscriptions = new Map<string, { unsubscribe: () => Promise<void> }>();
  protected readonly inFlight = new Map<JsonRpcId, () => void>();
  protected closed = false;

  constructor(
    protected readonly gateway: DispatchHost,
    /**
     * Ingress identity for THIS connection — established once by the
     * transport (AuthSource at handshake/request time, ADR 34) and
     * carried into every dispatch. Undefined = anonymous (local pole).
     * Mutated exactly once: the initialize frame's scope request
     * DOWNSCOPES it (#198) — effective scopes = claims ∩ requested.
     */
    protected identity?: IngressIdentity,
    /**
     * What the transport serving THIS connection says about itself — the
     * source of the `initialize` answer's `serverInfo` and its framing flags.
     * Each transport passes its own; omitted leaves `dispatchRequest` to name
     * the dispatcher itself.
     */
    protected readonly server?: WireServerDescriptor,
    /**
     * This connection's id, minted by the transport that owns the socket and
     * stable for its life. Absent on a stateless edge.
     */
    protected readonly connectionId?: string,
  ) {}

  /**
   * The client behind this connection, bound at handshake and held for its
   * life. `undefined` until `initialize` runs.
   */
  protected clientId: string | undefined;

  /**
   * Subclasses call this with every decoded inbound JSON-RPC frame.
   * Returns the response for requests; `null` for notifications.
   * Subclass is responsible for writing the response (if non-null) via
   * its own wire mechanism.
   */
  protected async dispatchInbound(frame: JsonRpcFrame): Promise<JsonRpcResponse | null> {
    if (this.closed) return null;

    if ("method" in frame && !("id" in frame)) {
      this.handleClientNotification(frame);
      return null;
    }
    if ("id" in frame && "method" in frame) {
      // #198 — connect-time scope request. Intersection only: a client
      // can narrow its credential's claims, never widen them. Applied
      // before dispatch so initialize itself and everything after run
      // under the effective scopes.
      if (frame.method === "initialize" && this.identity?.scopes !== undefined) {
        const requested = (frame as { params?: { scopes?: readonly string[] } }).params?.scopes;
        if (requested !== undefined) {
          this.identity = {
            ...this.identity,
            // Cover-aware (glob claims survive narrowing to their
            // members; review finding: exact-string intersection locked
            // out any glob-claim client). Narrowing-only in both
            // directions by construction.
            scopes: intersectScopes(this.identity.scopes, requested),
          };
        }
      }
      // `defaultSink()` — NOT a re-declaration of the same five callbacks. The
      // inline copy that used to live here bypassed the public methods, so
      // `sub/unsubscribe` deleted its registry entry without running the
      // cleanup and the server-side drain loop leaked.
      return dispatchRequest(this.gateway, frame as JsonRpcRequest, this.defaultSink(), {
        ...(this.identity !== undefined ? { identity: this.identity } : {}),
        ...(this.connectionId !== undefined ? { connectionId: this.connectionId } : {}),
        ...(this.clientId !== undefined ? { clientId: this.clientId } : {}),
        ...(this.server !== undefined ? { server: this.server } : {}),
        // Bound ONCE. A second `initialize` on a live connection cannot
        // re-point it at another client and inherit that client's work.
        bindClientId: (requested) => (this.clientId ??= requested ?? `client-${generateId()}`),
      });
    }
    return null;
  }

  private handleClientNotification(frame: JsonRpcFrame): void {
    if (!("method" in frame)) return;
    if (frame.method !== "notifications/cancelled") return;
    const params = frame.params as { requestId?: JsonRpcId } | undefined;
    if (params?.requestId === undefined) return;
    const abort = this.inFlight.get(params.requestId);
    if (abort) abort();
  }

  /**
   * Write a frame to the wire. Wire-specific encoding lives in the
   * subclass.
   */
  protected abstract sendFrame(frame: JsonRpcFrame): void;

  /**
   * Tear down the wire connection. Called from `close()` after the
   * subscription + in-flight cleanup loops complete.
   */
  protected abstract closeWire(): void | Promise<void>;

  /**
   * Helper for the server adapter to push a single frame from outside
   * the dispatch loop (e.g., heartbeat, server-initiated notification).
   */
  send(frame: JsonRpcFrame): void {
    if (this.closed) return;
    this.sendFrame(frame);
  }

  sendError(id: JsonRpcId | null, error: JsonRpcError): void {
    this.send({ jsonrpc: "2.0", id, error } as JsonRpcResponse);
  }

  /**
   * Cancel an in-flight RPC by JSON-RPC id. Used by server adapters
   * whose wire-level cancellation flows OUTSIDE the standard inbound
   * route (HTTP receives `notifications/cancelled` as a separate POST).
   */
  cancelInFlight(id: JsonRpcId): void {
    const abort = this.inFlight.get(id);
    if (abort) abort();
  }

  // ── public registration helpers ─────────────────────────────────────
  //
  // Server adapters that dispatch RPCs directly via `dispatchRequest`
  // (e.g., HTTP's streaming POST, where notifications go on a separate
  // SSE channel) supply these callbacks as their `DispatchSink`. The
  // shared `dispatchInbound` already uses them internally.

  registerSubscription(subId: string, unsubscribe: () => Promise<void>): void {
    admitSubscriptionId(this.subscriptions, subId);
    this.subscriptions.set(subId, { unsubscribe });
  }
  /**
   * Drop a subscription AND run its cleanup.
   *
   * Forgetting the entry is not releasing it: the cleanup is what stops the
   * server-side drain loop and interrupts its bus fiber. `sub/unsubscribe`
   * routes here, so a client that unsubscribed used to leave the server
   * consuming its bus subscription for the life of the connection — the same
   * leak as never registering it at all, just later.
   *
   * Best-effort and fire-and-forget: the wire method returns `null`
   * immediately, and one failing cleanup must not take the connection with it
   * (`close()` swallows the same way).
   */
  unregisterSubscription(subId: string): void {
    const entry = this.subscriptions.get(subId);
    if (!entry) return;
    this.subscriptions.delete(subId);
    void Promise.resolve()
      .then(() => entry.unsubscribe())
      .catch(() => {
        /* swallow — teardown is best-effort */
      });
  }
  registerInFlight(id: JsonRpcId, abort: () => void): void {
    this.inFlight.set(id, abort);
  }
  unregisterInFlight(id: JsonRpcId): void {
    this.inFlight.delete(id);
  }

  /**
   * The connection's canonical {@link DispatchSink} — subscriptions and
   * in-flight registrations land in this connection's registries, and
   * notifications route through {@link sendNotification} (which HTTP
   * overrides to the persistent GET stream). Server adapters that call
   * `dispatchRequest` directly (HTTP's per-request POST — where a
   * notification sink cannot be the POST response itself) use this rather
   * than re-declaring the same five callbacks at every call site. A
   * streaming POST overrides just `sendNotification` on top of it
   * (`{ ...conn.defaultSink(), sendNotification }`).
   */
  defaultSink(): DispatchSink {
    return {
      sendNotification: (n) => this.sendNotification(n),
      registerSubscription: (subId, unsubscribe) => this.registerSubscription(subId, unsubscribe),
      unregisterSubscription: (subId) => this.unregisterSubscription(subId),
      registerInFlight: (id, abort) => this.registerInFlight(id, abort),
      unregisterInFlight: (id) => this.unregisterInFlight(id),
    };
  }

  /**
   * Default notification sink — sends via the wire. Server adapters
   * that need to route notifications to a separate channel (HTTP's
   * persistent GET) override this method.
   */
  sendNotification(notification: { method: string; params?: unknown }): void {
    this.send({
      jsonrpc: "2.0",
      method: notification.method,
      params: notification.params,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const { unsubscribe } of this.subscriptions.values()) {
      try {
        await unsubscribe();
      } catch {
        /* swallow */
      }
    }
    this.subscriptions.clear();
    // In-flight RPCs are NOT aborted on connection close — aborts are
    // explicit (`notifications/cancelled`). A disconnect (browser refresh,
    // network drop) must not kill a running execution: the session carries
    // on, results persist, and the reconnecting client finds them. What a
    // dead connection loses is only its OBSERVATION of the work — the
    // response/notification writes fall on a closed wire and are swallowed.
    this.inFlight.clear();
    try {
      await this.closeWire();
    } catch {
      /* swallow */
    }
  }
}
