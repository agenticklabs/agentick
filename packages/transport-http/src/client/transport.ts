/**
 * Streamable HTTP `ClientTransport`.
 *
 * Subclasses `BaseClientTransport` and supplies HTTP-specific connection
 * management — POST per outbound RPC frame (response is either
 * `application/json` for non-streaming or `text/event-stream` for
 * `_meta.progressToken`-bearing requests), persistent GET for the
 * notification channel, DELETE on close. Reconnect, RPC correlation,
 * subscription multiplexing, cursor-aware resubscribe all live in the
 * base.
 *
 * Session affinity via the `Mcp-Session-Id` header per MCP convention.
 *
 * Uses universal `fetch` (Node 22+, browser, Bun, Deno, edge).
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import type { ClientTransport, JsonRpcFrame, TransportCapabilities } from "@agentick/spec";
import {
  BaseClientTransport,
  CSRF_HEADER,
  DEFAULT_RECONNECT_POLICY,
  type ReconnectPolicy,
} from "@agentick/transport/client";
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
   * (e.g., `Authorization: Bearer ...`). Snapshotted at construction.
   */
  readonly headers?: Record<string, string>;
}

export type { ReconnectPolicy };

const CAPABILITIES: TransportCapabilities = {
  bidirectional: false,
  streamingRequest: true,
  reconnectable: true,
  binaryFrames: false,
  media: false,
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

  private sessionId: string | null = null;
  private notificationAbort: AbortController | null = null;
  /**
   * Per-process CSRF token issued by the server on the bootstrap handshake
   * (the GET notification-stream open, STATUS A2 §4c). Echoed in the custom
   * {@link CSRF_HEADER} on every mutation (POST / DELETE). `null` until the
   * stream opens or the server does not require CSRF.
   */
  private csrfToken: string | null = null;

  constructor(options: HttpTransportOptions) {
    super();
    this.id = options.id ?? `http-${++transportCounter}`;
    this.url = options.url;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseHeaders = { ...(options.headers ?? {}) };
    this.reconnectPolicy = { ...DEFAULT_RECONNECT_POLICY, ...(options.reconnect ?? {}) };
  }

  protected async openConnection(): Promise<void> {
    this.explicitClose = false;
    this.setState("connecting");
    await this.openNotificationStream();
    this.resetReconnectAttempts();
    this.setState("open");
    this.resubscribeAfterReconnect();
  }

  protected async closeConnection(): Promise<void> {
    this.explicitClose = true;
    this.cancelReconnect();
    if (this.notificationAbort) {
      this.notificationAbort.abort();
      this.notificationAbort = null;
    }

    if (this.sessionId) {
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

    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        ...this.headersWithSession(),
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(frame),
    });

    const newSessionId = response.headers.get(SESSION_ID_HEADER);
    if (newSessionId && !this.sessionId) this.sessionId = newSessionId;
    const token = response.headers.get(CSRF_HEADER);
    if (token) this.csrfToken = token;

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      if (!response.body) return;
      for await (const result of parseSseFrames(response.body)) {
        if (!result.ok) continue;
        const f = result.frame;
        if (Array.isArray(f)) {
          for (const sub of f) this.routeFrame(sub as JsonRpcFrame);
        } else {
          this.routeFrame(f as JsonRpcFrame);
        }
      }
      return;
    }

    // `204 No Content` — the server's answer to a notification frame (the
    // `notifications/cancelled` this client sends on every abort). There is no
    // body by definition, so leave it unread: parsing it would throw on every
    // cancellation. (`204` IS `ok`, so this cannot be predicated on `!ok`.)
    if (response.status === 204) return;
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

  // ── persistent notification GET stream ───────────────────────────────

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

    // Capture the CSRF token from the bootstrap handshake so mutations can
    // echo it. Absent header = the server does not require CSRF.
    const token = response.headers.get(CSRF_HEADER);
    if (token) this.csrfToken = token;

    // Drain in background — termination triggers reconnect machinery.
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
      /* fall through to handleConnectionDrop */
    }

    if (signal.aborted) return;
    // Wire dropped — delegate to the base's shared reconnect machinery.
    this.handleConnectionDrop();
  }

  private headersWithSession(): Record<string, string> {
    const h: Record<string, string> = { ...this.baseHeaders };
    if (this.sessionId) h[SESSION_ID_HEADER] = this.sessionId;
    if (this.csrfToken) h[CSRF_HEADER] = this.csrfToken;
    return h;
  }
}
