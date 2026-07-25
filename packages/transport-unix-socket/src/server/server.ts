/**
 * Unix-socket server adapter — accepts NDJSON-framed JSON-RPC frames
 * over a `net.Server`, dispatches to a `GatewayHarness` via the shared
 * `dispatchRequest`, fans subscription / progress notifications back
 * over the same socket.
 *
 * Listens on a caller-supplied socket path (`net.Server.listen(path)`).
 * Caller owns the path lifecycle (unlink on shutdown if not using
 * `net.Server`'s built-in cleanup).
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import { createServer as netCreateServer, type Server, type Socket } from "node:net";
import {
  ErrorCode,
  type AuthSource,
  type IngressIdentity,
  type JsonRpcError,
  type JsonRpcFrame,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "@agentick/spec";
import { authenticateIngress, dispatchRequest, type DispatchHost } from "@agentick/transport";
import { NdjsonDecoder, encodeNdjson } from "../shared/ndjson.js";

export interface UnixSocketServerOptions {
  readonly path: string;
  readonly gateway: DispatchHost;
  /**
   * Stable id of the owning `ServerTransport`, threaded into the
   * `gateway:accept` op's `ConnectionInfo.transportId` (ADR 84 §4). The
   * `unixSocketServerTransport` wrapper passes its own id; a direct caller may
   * override it. Defaults to `"unix"`.
   */
  readonly transportId?: string;
  /**
   * Ingress authentication (ADR 61). A unix socket is host-local trust,
   * so the default crossing carries `credential.kind: "none"` — no
   * principal, the local pole. An adopter MAY supply an AuthSource for
   * parity with the network transports; a rejection destroys the socket
   * (fail closed).
   *
   * TODO(#146): peer-credential enrichment (SO_PEERCRED → principal) is
   * a later ingress interceptor — the host verifies the connecting uid,
   * not a bearer token.
   */
  readonly authSource?: AuthSource;
}

export interface UnixSocketServerHandle {
  readonly server: Server;
  close(): Promise<void>;
}

export function unixSocketServer(options: UnixSocketServerOptions): UnixSocketServerHandle {
  const liveConnections = new Set<ConnectionContext>();
  const transportId = options.transportId ?? "unix";

  const server = netCreateServer((socket) => {
    // Authenticate the crossing once per connection (ADR 61). Default
    // credential is `none` (host-local trust). Incoming bytes buffer on
    // the paused socket until the ConnectionContext attaches its `data`
    // listener a microtask later, so no frames are lost.
    void authenticateIngress(
      { transportKind: "unix", credential: { kind: "none" } },
      options.authSource,
    )
      .then(async (ingress) => {
        // ADR 84 §4 — per-connection admission. Fire `gateway:accept` AFTER
        // ingress-authn and BEFORE the ConnectionContext attaches its `data`
        // listener. A throwing `onBeforeGatewayAccept` REJECTS the connection:
        // destroy the socket and never wire it up. (Bytes buffer on the paused
        // socket meanwhile — dropping it loses nothing.)
        await options.gateway.accept({
          transportId,
          ...(ingress.identity !== undefined ? { identity: ingress.identity } : {}),
        });
        const ctx = new ConnectionContext(socket, options.gateway, ingress.identity);
        liveConnections.add(ctx);
        socket.on("close", () => {
          liveConnections.delete(ctx);
          void ctx.close();
        });
        socket.on("error", () => {
          /* swallow — close handler does cleanup */
        });
      })
      .catch(() => {
        // Fail closed — either the AuthSource rejected the crossing (ADR 61) or
        // `onBeforeGatewayAccept` rejected the connection (ADR 84 §4). Either
        // way the socket is dropped; one rejection never disturbs the listener.
        socket.destroy();
      });
  });

  server.listen(options.path);

  return {
    server,
    async close() {
      for (const ctx of liveConnections) await ctx.close();
      liveConnections.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

// ============================================================================
// ConnectionContext — per-socket server state
// ============================================================================

class ConnectionContext {
  private readonly subscriptions = new Map<string, { unsubscribe: () => Promise<void> }>();
  private readonly inFlight = new Map<JsonRpcId, () => void>();
  private readonly decoder = new NdjsonDecoder();
  private closed = false;

  constructor(
    private readonly socket: Socket,
    private readonly gateway: DispatchHost,
    /**
     * Ingress identity for this connection (ADR 61). Undefined = the
     * local pole (the host-local-trust default). Threaded into every
     * dispatch; never re-authenticated inward.
     */
    private readonly identity?: IngressIdentity,
  ) {
    socket.on("data", (chunk: Buffer) => {
      void this.handleData(chunk);
    });
  }

  private async handleData(chunk: Buffer): Promise<void> {
    if (this.closed) return;
    for (const result of this.decoder.push(chunk)) {
      if (!result.ok) {
        this.sendError(null, result.error);
        continue;
      }
      const frame = result.frame;
      if (Array.isArray(frame)) {
        const responses = await Promise.all(frame.map((f) => this.handleFrame(f as JsonRpcFrame)));
        for (const r of responses) {
          if (r !== null) this.send(r);
        }
        continue;
      }
      const response = await this.handleFrame(frame as JsonRpcFrame);
      if (response !== null) this.send(response);
    }
  }

  private async handleFrame(frame: JsonRpcFrame): Promise<JsonRpcResponse | null> {
    if ("method" in frame && !("id" in frame)) {
      this.handleNotification(frame);
      return null;
    }
    if ("id" in frame && "method" in frame) {
      return dispatchRequest(
        this.gateway,
        frame as JsonRpcRequest,
        {
          sendNotification: (n) =>
            this.send({ jsonrpc: "2.0", method: n.method, params: n.params }),
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
        },
        this.identity,
      );
    }
    return null;
  }

  private handleNotification(frame: JsonRpcFrame): void {
    if (!("method" in frame)) return;
    if (frame.method !== "notifications/cancelled") return;
    const params = frame.params as { requestId?: JsonRpcId } | undefined;
    if (params?.requestId === undefined) return;
    const abort = this.inFlight.get(params.requestId);
    if (abort) abort();
  }

  send(frame: JsonRpcFrame): void {
    if (this.closed) return;
    if (this.socket.destroyed) return;
    try {
      this.socket.write(encodeNdjson(frame));
    } catch {
      /* swallow */
    }
  }

  private sendError(id: JsonRpcId | null, error: JsonRpcError): void {
    this.send({ jsonrpc: "2.0", id, error } as JsonRpcResponse);
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
    if (!this.socket.destroyed) {
      try {
        this.socket.end();
      } catch {
        /* swallow */
      }
    }
  }
}

export type { DispatchHost };
export { ErrorCode };
