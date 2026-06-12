/**
 * Streamable HTTP `ClientTransport`.
 *
 * Subclasses `BaseClientTransport` and supplies HTTP-specific
 * connection management:
 *
 *   - `POST <url>` for every outbound JSON-RPC frame. Server responds
 *     with `application/json` (single response) or `text/event-stream`
 *     (streaming notifications followed by final response).
 *   - `GET <url>` with `Accept: text/event-stream` opens a persistent
 *     SSE channel for notifications that aren't bound to any specific
 *     RPC (subscription events, unsolicited auth notifications).
 *   - `DELETE <url>` on close terminates the server-side connection
 *     state (releases per-connection subscriptions, in-flight tracking).
 *
 * Session affinity via the `Mcp-Session-Id` header (MCP convention) —
 * server returns it on the `initialize` response; client echoes it on
 * every subsequent POST. Load balancers sticky-route by header.
 *
 * Uses universal `fetch` (Node 22+, browser, Bun, Deno, edge).
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import type { ClientTransport, JsonRpcFrame, TransportCapabilities } from "@agentick/spec-next";
import { BaseClientTransport } from "@agentick/transport-next";
import { parseSseFrames } from "../shared/sse.js";

export interface HttpTransportOptions {
  readonly url: string;
  /**
   * Optional `fetch` override. Defaults to `globalThis.fetch`. Adopters
   * needing custom headers, mTLS, or a request interceptor can pass
   * a wrapped fetch.
   */
  readonly fetch?: typeof globalThis.fetch;
  readonly id?: string;
  readonly reconnect?: ReconnectPolicy;
  /**
   * Extra headers to attach to every request. Adopters pass auth here
   * (e.g., `Authorization: Bearer ...`). Mutating returned headers
   * mid-flight does NOT affect future requests; the constructor snapshots.
   */
  readonly headers?: Record<string, string>;
}

export interface ReconnectPolicy {
  readonly enabled?: boolean;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly maxAttempts?: number;
}

const DEFAULT_RECONNECT: Required<ReconnectPolicy> = {
  enabled: true,
  initialDelayMs: 100,
  maxDelayMs: 30_000,
  maxAttempts: Infinity,
};

const CAPABILITIES: TransportCapabilities = {
  bidirectional: false,
  streamingRequest: true,
  reconnectable: true,
  binaryFrames: false,
};

const SESSION_ID_HEADER = "Mcp-Session-Id";

let transportCounter = 0;

export function http(options: HttpTransportOptions): ClientTransport {
  return new HttpTransport(options);
}

class HttpTransport extends BaseClientTransport {
  readonly id: string;
  readonly capabilities = CAPABILITIES;

  private readonly url: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseHeaders: Record<string, string>;
  private readonly reconnect: Required<ReconnectPolicy>;

  private sessionId: string | null = null;
  private notificationStream: ReadableStream<Uint8Array> | null = null;
  private notificationAbort: AbortController | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private explicitClose = false;

  constructor(options: HttpTransportOptions) {
    super();
    this.id = options.id ?? `http-${++transportCounter}`;
    this.url = options.url;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseHeaders = { ...(options.headers ?? {}) };
    this.reconnect = { ...DEFAULT_RECONNECT, ...(options.reconnect ?? {}) };
  }

  protected async openConnection(): Promise<void> {
    this.explicitClose = false;
    this.setState("connecting");
    await this.openNotificationStream();
    this.setState("open");
  }

  protected async closeConnection(): Promise<void> {
    this.explicitClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.notificationAbort) {
      this.notificationAbort.abort();
      this.notificationAbort = null;
    }
    this.notificationStream = null;

    if (this.sessionId) {
      // Best-effort DELETE — server cleans up per-connection state.
      try {
        await this.fetchImpl(this.url, {
          method: "DELETE",
          headers: this.headersWithSession(),
        });
      } catch {
        /* swallow */
      }
      this.sessionId = null;
    }
  }

  protected async sendFrame(frame: JsonRpcFrame): Promise<void> {
    if (this.currentState !== "open") return;

    const isRequestWithProgress =
      "id" in frame &&
      "method" in frame &&
      isObject((frame as { params?: unknown }).params) &&
      isObject(
        ((frame as { params: Record<string, unknown> }).params as Record<string, unknown>)._meta,
      ) &&
      typeof (
        (frame as { params: { _meta: Record<string, unknown> } }).params._meta as {
          progressToken?: unknown;
        }
      ).progressToken === "string";

    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        ...this.headersWithSession(),
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(frame),
    });

    // Capture session id from the initialize response if present.
    const newSessionId = response.headers.get(SESSION_ID_HEADER);
    if (newSessionId && !this.sessionId) this.sessionId = newSessionId;

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      // Streaming response — drain SSE frames as notifications until
      // the final response arrives.
      if (!response.body) {
        // No body — surface as protocol error on the pending RPC.
        return;
      }
      for await (const result of parseSseFrames(response.body)) {
        if (!result.ok) continue;
        const f = result.frame;
        if (Array.isArray(f)) {
          for (const sub of f) this.routeFrame(sub as JsonRpcFrame);
        } else {
          this.routeFrame(f as JsonRpcFrame);
        }
      }
      void isRequestWithProgress; // semantic marker; payload-shape decides routing
      return;
    }

    // Single JSON response.
    if (!response.ok && response.status === 204) return;
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return;
    }
    if (Array.isArray(body)) {
      for (const sub of body) this.routeFrame(sub as JsonRpcFrame);
    } else {
      this.routeFrame(body as JsonRpcFrame);
    }
  }

  // ── notification GET stream ──────────────────────────────────────────

  private async openNotificationStream(): Promise<void> {
    const abort = new AbortController();
    this.notificationAbort = abort;

    const response = await this.fetchImpl(this.url, {
      method: "GET",
      headers: {
        ...this.headersWithSession(),
        Accept: "text/event-stream",
      },
      signal: abort.signal,
    });

    if (!response.ok || !response.body) {
      throw {
        kind: "connection",
        message: `notification stream open failed (status ${response.status})`,
      };
    }

    this.notificationStream = response.body;
    // Drain in the background — terminates when the wire drops or the
    // controller aborts. The drain promise's rejection triggers reconnect.
    void this.drainNotifications(response.body, abort.signal);
  }

  private async drainNotifications(
    stream: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      for await (const result of parseSseFrames(stream)) {
        if (signal.aborted) return;
        if (!result.ok) continue;
        const frame = result.frame;
        if (Array.isArray(frame)) {
          for (const sub of frame) this.routeFrame(sub as JsonRpcFrame);
        } else {
          this.routeFrame(frame as JsonRpcFrame);
        }
      }
    } catch {
      // Network failure or aborted — fall through to reconnect logic.
    }

    if (signal.aborted || this.explicitClose) return;

    // Connection dropped; reconnect if policy allows.
    if (!this.reconnect.enabled) {
      this.setState("closed");
      return;
    }
    if (this.reconnectAttempts >= this.reconnect.maxAttempts) {
      this.setState({
        kind: "failed",
        error: { kind: "connection", message: "reconnect attempts exhausted" },
      });
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.setState("reconnecting");
    const delay = this.computeBackoff(this.reconnectAttempts);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openNotificationStream()
        .then(() => {
          this.reconnectAttempts = 0;
          this.setState("open");
          this.resubscribeAfterReconnect();
        })
        .catch(() => {
          // openNotificationStream fail → drainNotifications path won't
          // be reached; schedule another reconnect.
          if (!this.explicitClose) this.scheduleReconnect();
        });
    }, delay);
  }

  /**
   * Exponential backoff with full jitter per AWS Builder's Library
   * "Timeouts, retries, and backoff with jitter".
   */
  private computeBackoff(attempt: number): number {
    const exp = Math.min(this.reconnect.maxDelayMs, this.reconnect.initialDelayMs * 2 ** attempt);
    return Math.random() * exp;
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private headersWithSession(): Record<string, string> {
    const h: Record<string, string> = { ...this.baseHeaders };
    if (this.sessionId) h[SESSION_ID_HEADER] = this.sessionId;
    return h;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
