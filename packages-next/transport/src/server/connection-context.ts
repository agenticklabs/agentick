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
} from "@agentick/spec-next";
import { dispatchRequest, type DispatchHost } from "./dispatch.js";

export abstract class BaseConnectionContext {
  protected readonly subscriptions = new Map<string, { unsubscribe: () => Promise<void> }>();
  protected readonly inFlight = new Map<JsonRpcId, () => void>();
  protected closed = false;

  constructor(protected readonly gateway: DispatchHost) {}

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
      return dispatchRequest(this.gateway, frame as JsonRpcRequest, {
        sendNotification: (n) =>
          this.sendFrame({ jsonrpc: "2.0", method: n.method, params: n.params }),
        registerSubscription: (subId, unsubscribe) => {
          this.subscriptions.set(subId, { unsubscribe });
        },
        unregisterSubscription: (subId) => {
          this.subscriptions.delete(subId);
        },
        registerInFlight: (id, abort) => {
          this.inFlight.set(id, abort);
        },
        unregisterInFlight: (id) => {
          this.inFlight.delete(id);
        },
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
    this.subscriptions.set(subId, { unsubscribe });
  }
  unregisterSubscription(subId: string): void {
    this.subscriptions.delete(subId);
  }
  registerInFlight(id: JsonRpcId, abort: () => void): void {
    this.inFlight.set(id, abort);
  }
  unregisterInFlight(id: JsonRpcId): void {
    this.inFlight.delete(id);
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
    for (const abort of this.inFlight.values()) {
      try {
        abort();
      } catch {
        /* swallow */
      }
    }
    this.inFlight.clear();
    try {
      await this.closeWire();
    } catch {
      /* swallow */
    }
  }
}
