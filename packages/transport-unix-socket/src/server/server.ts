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
import { NdjsonDecoder, encodeNdjson, type NdjsonDecoderOptions } from "../shared/ndjson.js";

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
  /**
   * Wall-clock ceiling on the `authSource` call, in milliseconds. Defaults to
   * `DEFAULT_INGRESS_AUTHN_TIMEOUT_MS` (10s); `Infinity` opts out. Exceeding it
   * destroys the socket (fail closed) rather than holding it open on a hung
   * authenticator.
   */
  readonly authnTimeoutMs?: number;
  /**
   * Bytes one inbound NDJSON line may occupy before the connection is refused
   * and closed. Defaults to `DEFAULT_MAX_LINE_BYTES` (16 MiB). Framing is "read
   * until newline", so without a cap a peer that never sends one grows this
   * process's memory for as long as it keeps writing.
   */
  readonly maxLineBytes?: number;
  /**
   * Where non-fatal failures at this edge are reported.
   *
   * A transport whose whole job is moving bytes between two processes must not
   * hide the byte-moving failing. Every site that has to stay best-effort —
   * teardown must not throw, one rude peer must not take the listener down —
   * reports here instead of swallowing: a reset or broken-pipe socket error, a
   * failed write, a subscription cleanup or in-flight abort that threw.
   *
   * The DEFAULT is quiet: a host-local socket losing a peer is ordinary, and a
   * framework that logs on its own behalf is a framework fighting its adopter.
   * The seam is the capability; what to do with it is the adopter's policy.
   * Reporting NEVER changes behavior — teardown proceeds either way — and a
   * throwing reporter is its own bug (it is called inside the same try that was
   * already swallowing).
   */
  readonly onFailure?: (failure: UnixSocketFailure) => void;
}

/** The site that failed — see {@link UnixSocketServerOptions.onFailure}. */
export type UnixSocketFailureSite =
  /** The `net.Server` itself emitted `error` after a successful bind. */
  | "server"
  /** A connection's socket emitted `error` (a reset peer, a broken pipe). */
  | "socket"
  /** Writing a frame to the socket threw. */
  | "write"
  /** Ending the socket during teardown threw. */
  | "close"
  /** A registered subscription cleanup rejected during teardown. */
  | "subscription-cleanup"
  /** An in-flight abort callback threw during teardown. */
  | "abort";

export interface UnixSocketFailure {
  readonly at: UnixSocketFailureSite;
  readonly error: unknown;
}

export interface UnixSocketServerHandle {
  readonly server: Server;
  /**
   * Resolves once the socket is accepting; REJECTS with the bind error.
   *
   * A `net.Server` reports a bind failure by emitting `error`, and an
   * unhandled `error` on an EventEmitter is a thrown exception at the top of
   * the event loop. The most likely failure for this transport — a stale socket
   * file from an unclean shutdown (`EADDRINUSE`) — would otherwise take the
   * process down from a callback no adopter could catch. The listeners are
   * attached BEFORE `listen()`, so the failure is always claimed; this promise
   * is how you read it. Ignoring it is safe (the rejection is pre-handled), but
   * then a failed bind is silent.
   */
  listening(): Promise<void>;
  close(): Promise<void>;
}

export function unixSocketServer(options: UnixSocketServerOptions): UnixSocketServerHandle {
  const liveConnections = new Set<ConnectionContext>();
  const transportId = options.transportId ?? "unix";
  const report = (failure: UnixSocketFailure): void => options.onFailure?.(failure);

  const server = netCreateServer((socket) => {
    // Authenticate the crossing once per connection (ADR 61). Default
    // credential is `none` (host-local trust). Incoming bytes buffer on
    // the paused socket until the ConnectionContext attaches its `data`
    // listener a microtask later, so no frames are lost.
    void authenticateIngress(
      { transportKind: "unix", credential: { kind: "none" } },
      options.authSource,
      {
        // ADR 92 §Family 1.3 — a refused crossing leaves an audit trace. A unix
        // socket is host-local, so there is no peer address to attribute; the
        // failure carries the transport kind and the refusal reason only.
        onRejected: (failure) => options.gateway.emitAdmissionFailure?.(failure),
        // A hung AuthSource would otherwise hold this socket open forever.
        ...(options.authnTimeoutMs !== undefined ? { timeoutMs: options.authnTimeoutMs } : {}),
      },
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
        const ctx = new ConnectionContext(
          socket,
          options.gateway,
          ingress.identity,
          { ...(options.maxLineBytes !== undefined ? { maxLineBytes: options.maxLineBytes } : {}) },
          report,
        );
        liveConnections.add(ctx);
        socket.on("close", () => {
          liveConnections.delete(ctx);
          void ctx.close();
        });
        socket.on("error", (error) => {
          // Non-fatal by design — the `close` handler does the cleanup. Reported
          // rather than swallowed so a broken pipe is not invisible.
          report({ at: "socket", error });
        });
      })
      .catch(() => {
        // Fail closed — either the AuthSource rejected the crossing (ADR 61) or
        // `onBeforeGatewayAccept` rejected the connection (ADR 84 §4). Either
        // way the socket is dropped; one rejection never disturbs the listener.
        socket.destroy();
      });
  });

  // Post-bind server errors are non-fatal to the process but must not be
  // unhandled either — the one-shot bind listener below is removed on success,
  // so this is what keeps the emitter claimed for the server's whole life.
  server.on("error", (error) => report({ at: "server", error }));

  // Claim the bind outcome BEFORE listening, so an `error` emitted during bind
  // always has a listener and can never reach `uncaughtException`.
  const bound = new Promise<void>((resolve, reject) => {
    const onListening = (): void => {
      server.removeListener("error", onBindError);
      resolve();
    };
    const onBindError = (err: Error): void => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    server.once("listening", onListening);
    server.once("error", onBindError);
  });
  // Pre-handle it: an adopter who never calls `listening()` must not get an
  // unhandled-rejection crash in place of the uncaught-exception one.
  bound.catch(() => {});

  server.listen(options.path);

  return {
    server,
    listening: () => bound,
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
  private readonly decoder: NdjsonDecoder;
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
    options: NdjsonDecoderOptions = {},
    private readonly report: (failure: UnixSocketFailure) => void = () => {},
  ) {
    this.decoder = new NdjsonDecoder(options);
    socket.on("data", (chunk: Buffer) => {
      void this.handleData(chunk);
    });
  }

  private async handleData(chunk: Buffer): Promise<void> {
    if (this.closed) return;
    for (const result of this.decoder.push(chunk)) {
      if (!result.ok) {
        this.sendError(null, result.error);
        // A fatal refusal means framing is lost (an oversized line). Report it,
        // then close: there is no byte offset at which reading could safely
        // resume, and a peer that overran the cap once will do it again.
        if (result.fatal === true) {
          void this.close();
          return;
        }
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
    } catch (error) {
      // Best-effort by design (a dead peer must not fault the dispatch that
      // wrote to it) — but reported, not silent.
      this.report({ at: "write", error });
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
      } catch (error) {
        // One failing cleanup must not abandon the rest.
        this.report({ at: "subscription-cleanup", error });
      }
    }
    this.subscriptions.clear();
    for (const abort of this.inFlight.values()) {
      try {
        abort();
      } catch (error) {
        this.report({ at: "abort", error });
      }
    }
    this.inFlight.clear();
    if (!this.socket.destroyed) {
      try {
        this.socket.end();
      } catch (error) {
        this.report({ at: "close", error });
      }
    }
  }
}

export type { DispatchHost };
export { ErrorCode };
