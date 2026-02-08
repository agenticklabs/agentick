/**
 * Shared Transport
 *
 * A ClientTransport implementation that multiplexes connections across browser tabs.
 * Only the leader tab maintains a real SSE connection; followers communicate via BroadcastChannel.
 */

import {
  createSSETransport,
  createWSTransport,
  type ClientTransport,
  type TransportConfig,
  type TransportState,
  type TransportEventData,
  type SSETransportConfig,
  type WSTransportConfig,
  type SendInput,
  type ChannelEvent,
  type ToolConfirmationResponse,
} from "@agentick/client";
import { createLeaderElector, type LeaderElector } from "./leader-elector.js";
import {
  createBroadcastBridge,
  generateRequestId,
  type BroadcastBridge,
  type BridgeMessage,
} from "./broadcast-bridge.js";

// ============================================================================
// Configuration
// ============================================================================

export interface SharedTransportConfig extends TransportConfig {
  /**
   * Transport type to use.
   * - "sse": HTTP/SSE transport (default for http:// URLs)
   * - "websocket": WebSocket transport (default for ws:// URLs)
   * - "auto": Auto-detect based on URL scheme (default)
   * @default "auto"
   */
  transport?: "sse" | "websocket" | "auto";

  /** Override default endpoint paths (SSE transport only) */
  paths?: SSETransportConfig["paths"];

  /** Client ID for WebSocket connections */
  clientId?: string;

  /** WebSocket implementation (for Node.js compatibility) */
  WebSocket?: WSTransportConfig["WebSocket"];

  /** Reconnection settings (WebSocket only) */
  reconnect?: WSTransportConfig["reconnect"];
}

// ============================================================================
// Shared Transport Implementation
// ============================================================================

export class SharedTransport implements ClientTransport {
  private config: SharedTransportConfig;
  private elector: LeaderElector;
  private bridge: BroadcastBridge;

  // Real transport (only used by leader)
  private realTransport: ClientTransport | null = null;

  // This tab's subscriptions
  private mySessionSubscriptions = new Set<string>();
  private myChannelSubscriptions = new Set<string>(); // "sessionId:channelName"

  // State
  private _state: TransportState = "disconnected";
  private _connectionId: string | undefined;

  // Handlers
  private eventHandlers = new Set<(event: TransportEventData) => void>();
  private stateHandlers = new Set<(state: TransportState) => void>();

  // Pending requests (for followers awaiting responses)
  private pendingRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  // Pending send streams (for followers)
  private pendingStreams = new Map<
    string,
    {
      events: TransportEventData[];
      resolve: () => void;
      reject: (error: Error) => void;
      aborted: boolean;
    }
  >();

  // Ready promise - resolves when transport is truly operational
  private readyResolve?: () => void;
  private readyPromise?: Promise<void>;

  constructor(config: SharedTransportConfig) {
    this.config = config;

    const channelKey = config.baseUrl.replace(/[^a-zA-Z0-9]/g, "_");
    this.elector = createLeaderElector(channelKey);
    this.bridge = createBroadcastBridge(channelKey, this.elector.tabId);

    this.setupBridgeHandlers();
    this.setupLeadershipHandlers();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ClientTransport Interface
  // ══════════════════════════════════════════════════════════════════════════

  get state(): TransportState {
    return this._state;
  }

  get connectionId(): string | undefined {
    return this._connectionId;
  }

  async connect(): Promise<void> {
    if (this._state === "connected" || this._state === "connecting") {
      // If already connecting, wait for ready
      if (this.readyPromise) {
        await this.readyPromise;
      }
      return;
    }

    this.setState("connecting");

    // Create ready promise
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });

    // Simple approach: wait for leadership election to complete
    // Web Locks will resolve quickly - either we get the lock (leader) or someone else has it (follower)
    await this.elector.awaitLeadership();

    // Now we know definitively if we're leader or not
    if (this.elector.isLeader) {
      // We're the leader - connect to the real server
      await this.connectAsLeader();
      this.readyResolve?.();
    } else {
      // We're a follower - the leader exists (they have the lock)
      this._connectionId = `follower-${this.elector.tabId}`;
      this.setState("connected");

      // Wait for the leader to be ready (they might still be connecting to server)
      await this.waitForLeader();
      this.readyResolve?.();
    }
  }

  /**
   * Wait until a leader is available AND ready to handle requests (for followers).
   * The key distinction is waiting for "leader:transport_ready" not just "leader:ready".
   */
  private waitForLeader(): Promise<void> {
    return new Promise((resolve) => {
      // Ask if there's a leader ready to handle requests
      this.bridge.broadcast({ type: "ping:leader", tabId: this.elector.tabId });

      const timeout = setTimeout(() => {
        cleanup();
        // No leader responded - we might need to become leader
        // Trigger re-election
        this.elector.awaitLeadership().catch(() => {});
        resolve();
      }, 2000); // Increased timeout to allow leader more time to connect

      const cleanup = this.bridge.onMessage((msg) => {
        // Only resolve when leader's TRANSPORT is ready, not just when leader exists
        // "pong:leader" is sent by leader with ready transport
        // "leader:transport_ready" is broadcast when leader finishes connecting
        // "event" means leader is actively sending events (definitely ready)
        if (
          msg.type === "pong:leader" ||
          msg.type === "leader:transport_ready" ||
          msg.type === "event"
        ) {
          clearTimeout(timeout);
          cleanup();
          resolve();
        }
        // Note: "leader:ready" is just the start of leader setup, not safe to use yet
      });
    });
  }

  disconnect(): void {
    if (this.elector.isLeader && this.realTransport) {
      this.realTransport.disconnect();
      this.realTransport = null;
    }

    this.elector.resign();
    this.bridge.close();

    this._connectionId = undefined;
    this.setState("disconnected");
  }

  send(
    input: SendInput,
    sessionId?: string,
  ): AsyncIterable<TransportEventData> & { abort: (reason?: string) => void } {
    const self = this;
    const effectiveSessionId = sessionId ?? "default";

    // Check if we can use real transport directly (leader with ready transport)
    if (this.elector.isLeader && this.realTransport) {
      return this.realTransport.send(input, sessionId);
    }

    // Either we're a follower OR we're a leader whose transport isn't ready yet.
    // In both cases, we need to wait and then decide how to proceed.
    const requestId = generateRequestId(this.elector.tabId);
    let aborted = false;

    const streamState = {
      events: [] as TransportEventData[],
      resolve: () => {},
      reject: (_error: Error) => {},
      aborted: false,
    };
    this.pendingStreams.set(requestId, streamState);

    const iterable = {
      async *[Symbol.asyncIterator](): AsyncIterator<TransportEventData> {
        // Wait for transport to be ready (handles leadership transitions)
        if (self.readyPromise) {
          await self.readyPromise;
        }

        // After waiting, check again if we should use real transport
        if (self.elector.isLeader && self.realTransport) {
          // We're leader with ready transport - use it directly
          self.pendingStreams.delete(requestId);
          const stream = self.realTransport.send(input, sessionId);
          for await (const event of stream) {
            yield event;
          }
          return;
        }

        // We're a follower - forward to leader via bridge
        self.bridge.broadcast({
          type: "request:send",
          requestId,
          tabId: self.elector.tabId,
          sessionId: effectiveSessionId,
          input,
        });

        // Wait for stream to complete or error
        await new Promise<void>((resolve, reject) => {
          streamState.resolve = resolve;
          streamState.reject = reject;
        });

        // Yield all collected events
        for (const event of streamState.events) {
          yield event;
        }

        self.pendingStreams.delete(requestId);
      },

      abort(reason?: string): void {
        if (aborted) return;
        aborted = true;
        streamState.aborted = true;

        // Tell leader to abort
        self.bridge.broadcast({
          type: "request:abort",
          requestId: generateRequestId(self.elector.tabId),
          tabId: self.elector.tabId,
          sessionId: effectiveSessionId,
          reason,
        });

        streamState.reject(new Error(reason ?? "Aborted"));
      },
    };

    return iterable;
  }

  async subscribeToSession(sessionId: string): Promise<void> {
    this.mySessionSubscriptions.add(sessionId);

    // Wait for transport to be ready
    if (this.readyPromise) {
      await this.readyPromise;
    }

    if (this.elector.isLeader && this.realTransport) {
      await this.realTransport.subscribeToSession(sessionId);
    } else {
      await this.forwardRequest("request:subscribe", { sessionId });
    }
  }

  async unsubscribeFromSession(sessionId: string): Promise<void> {
    this.mySessionSubscriptions.delete(sessionId);

    // Wait for transport to be ready
    if (this.readyPromise) {
      await this.readyPromise;
    }

    if (this.elector.isLeader && this.realTransport) {
      // Only unsubscribe if no other tabs need this session
      // For simplicity, leader always stays subscribed (cleanup on session close)
      await this.realTransport.unsubscribeFromSession(sessionId);
    } else {
      await this.forwardRequest("request:unsubscribe", { sessionId });
    }
  }

  async abortSession(sessionId: string, reason?: string): Promise<void> {
    // Wait for transport to be ready
    if (this.readyPromise) {
      await this.readyPromise;
    }

    if (this.elector.isLeader && this.realTransport) {
      await this.realTransport.abortSession(sessionId, reason);
    } else {
      await this.forwardRequest("request:abort", { sessionId, reason });
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    this.mySessionSubscriptions.delete(sessionId);
    // Remove channel subscriptions for this session
    for (const key of this.myChannelSubscriptions) {
      if (key.startsWith(`${sessionId}:`)) {
        this.myChannelSubscriptions.delete(key);
      }
    }

    // Wait for transport to be ready
    if (this.readyPromise) {
      await this.readyPromise;
    }

    if (this.elector.isLeader && this.realTransport) {
      await this.realTransport.closeSession(sessionId);
    } else {
      await this.forwardRequest("request:close", { sessionId });
    }
  }

  async submitToolResult(
    sessionId: string,
    toolUseId: string,
    result: ToolConfirmationResponse,
  ): Promise<void> {
    // Wait for transport to be ready
    if (this.readyPromise) {
      await this.readyPromise;
    }

    if (this.elector.isLeader && this.realTransport) {
      await this.realTransport.submitToolResult(sessionId, toolUseId, result);
    } else {
      await this.forwardRequest("request:toolResult", { sessionId, toolUseId, result });
    }
  }

  async subscribeToChannel(sessionId: string, channel: string): Promise<void> {
    const key = `${sessionId}:${channel}`;
    this.myChannelSubscriptions.add(key);

    // Wait for transport to be ready
    if (this.readyPromise) {
      await this.readyPromise;
    }

    if (this.elector.isLeader && this.realTransport) {
      await this.realTransport.subscribeToChannel(sessionId, channel);
    } else {
      await this.forwardRequest("request:channelSubscribe", { sessionId, channel });
    }
  }

  async publishToChannel(sessionId: string, channel: string, event: ChannelEvent): Promise<void> {
    // Wait for transport to be ready
    if (this.readyPromise) {
      await this.readyPromise;
    }

    if (this.elector.isLeader && this.realTransport) {
      await this.realTransport.publishToChannel(sessionId, channel, event);
    } else {
      await this.forwardRequest("request:channelPublish", { sessionId, channel, event });
    }
  }

  onEvent(handler: (event: TransportEventData) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onStateChange(handler: (state: TransportState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Leadership Info (optional, for debugging/UI)
  // ══════════════════════════════════════════════════════════════════════════

  get isLeader(): boolean {
    return this.elector.isLeader;
  }

  get tabId(): string {
    return this.elector.tabId;
  }

  onLeadershipChange(callback: (isLeader: boolean) => void): () => void {
    return this.elector.onLeadershipChange(callback);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Internal: Leadership Handling
  // ══════════════════════════════════════════════════════════════════════════

  private setupLeadershipHandlers(): void {
    this.elector.onLeadershipChange(async (isLeader) => {
      if (isLeader) {
        await this.onBecomeLeader();
      } else {
        this.onLoseLeadership();
      }
    });
  }

  private async onBecomeLeader(): Promise<void> {
    // Create a new ready promise for this transition
    // This ensures any pending requests wait until we're fully ready
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });

    // IMPORTANT: The order here is critical to avoid race conditions:
    // 1. First, collect subscriptions from other tabs (they need to know we're becoming leader)
    // 2. Then, connect our transport
    // 3. Then, re-subscribe on the new transport
    // 4. ONLY THEN announce we're ready to handle requests

    // Step 1: Request subscription info from other tabs (but DON'T signal readiness yet)
    this.bridge.broadcast({ type: "leader:collecting_subscriptions", tabId: this.elector.tabId });

    // Collect subscription announcements from other tabs
    const announcements = await this.bridge.collectResponses<{
      type: "subscriptions:announce";
      tabId: string;
      sessions: string[];
      channels: string[];
    }>("subscriptions:announce", 300);

    // Aggregate all subscriptions (ours + others)
    const allSessions = new Set(this.mySessionSubscriptions);
    const allChannels = new Set(this.myChannelSubscriptions);

    for (const ann of announcements) {
      for (const s of ann.sessions) allSessions.add(s);
      for (const c of ann.channels) allChannels.add(c);
    }

    // Step 2: Connect real transport
    try {
      await this.connectAsLeader();
    } catch (error) {
      console.error("Leader failed to connect transport:", error);
      // Resign leadership so another tab can try
      this.elector.resign();
      return;
    }

    // Step 3: Subscribe to aggregated sessions/channels
    if (this.realTransport) {
      for (const sessionId of allSessions) {
        await this.realTransport.subscribeToSession(sessionId).catch(() => {});
      }
      for (const channelKey of allChannels) {
        const [sessionId, channel] = channelKey.split(":");
        if (sessionId && channel) {
          await this.realTransport.subscribeToChannel(sessionId, channel).catch(() => {});
        }
      }
    }

    // Step 4: NOW we're fully ready - announce it so followers can proceed
    this.bridge.broadcast({ type: "leader:transport_ready", tabId: this.elector.tabId });

    // Mark ourselves as ready
    this.readyResolve?.();
  }

  private onLoseLeadership(): void {
    // Create a new ready promise for the transition to follower
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });

    // Clean up real transport
    if (this.realTransport) {
      this.realTransport.disconnect();
      this.realTransport = null;
    }

    // We're now a follower, stay "connected" via bridge
    this._connectionId = `follower-${this.elector.tabId}`;

    // Wait for new leader, then mark ready
    this.waitForLeader().then(() => {
      this.readyResolve?.();
    });
  }

  private async connectAsLeader(): Promise<void> {
    // Determine transport type
    const transportType = this.detectTransportType();

    if (transportType === "websocket") {
      this.realTransport = createWSTransport({
        baseUrl: this.config.baseUrl,
        token: this.config.token,
        headers: this.config.headers,
        timeout: this.config.timeout,
        withCredentials: this.config.withCredentials,
        clientId: this.config.clientId,
        WebSocket: this.config.WebSocket,
        reconnect: this.config.reconnect,
      });
    } else {
      this.realTransport = createSSETransport({
        ...this.config,
        paths: this.config.paths,
      });
    }

    // Forward events from real transport to all tabs via bridge
    this.realTransport.onEvent((event) => {
      // Broadcast to all tabs
      this.bridge.broadcast({ type: "event", event });

      // Also handle locally if we care about this session
      this.handleIncomingEvent(event);
    });

    this.realTransport.onStateChange((state) => {
      this.setState(state);

      // If leader's connection fails, resign so another tab can take over
      if (state === "error" && this.elector.isLeader) {
        console.warn("Leader transport error - resigning leadership");
        this.elector.resign();
      }
    });

    await this.realTransport.connect();
    this._connectionId = this.realTransport.connectionId;
    this.setState("connected");
  }

  private detectTransportType(): "sse" | "websocket" {
    if (this.config.transport && this.config.transport !== "auto") {
      return this.config.transport;
    }

    // Auto-detect based on URL scheme
    const url = this.config.baseUrl.toLowerCase();
    if (url.startsWith("ws://") || url.startsWith("wss://")) {
      return "websocket";
    }
    return "sse";
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Internal: Bridge Message Handling
  // ══════════════════════════════════════════════════════════════════════════

  private setupBridgeHandlers(): void {
    this.bridge.onMessage((msg) => this.handleBridgeMessage(msg));
  }

  private handleBridgeMessage(msg: BridgeMessage): void {
    switch (msg.type) {
      // Leadership coordination
      case "leader:collecting_subscriptions":
        // New leader is asking for subscriptions (but not ready yet)
        if (msg.tabId !== this.elector.tabId) {
          this.bridge.broadcast({
            type: "subscriptions:announce",
            tabId: this.elector.tabId,
            sessions: [...this.mySessionSubscriptions],
            channels: [...this.myChannelSubscriptions],
          });
        }
        break;

      case "leader:transport_ready":
        // Leader is now ready to handle requests - handled by waitForLeader promise
        break;

      case "ping:leader":
        // Follower asking if there's a leader ready to handle requests
        // IMPORTANT: Only respond if we have a ready transport, not just if we're the leader
        if (this.elector.isLeader && this.realTransport && msg.tabId !== this.elector.tabId) {
          this.bridge.broadcast({ type: "pong:leader", tabId: this.elector.tabId });
        }
        break;

      case "pong:leader":
        // Leader responded - handled by waitForLeader promise
        break;

      // Event from leader
      case "event":
        this.handleIncomingEvent(msg.event);
        break;

      // Stream events for pending sends
      case "stream:event":
        this.handleStreamEvent(msg.requestId, msg.event);
        break;

      case "stream:end":
        this.handleStreamEnd(msg.requestId);
        break;

      case "stream:error":
        this.handleStreamError(msg.requestId, msg.error);
        break;

      // Response to a request
      case "response":
        this.handleResponse(msg);
        break;

      // Requests from followers (only leader handles these)
      case "request:send":
      case "request:subscribe":
      case "request:unsubscribe":
      case "request:abort":
      case "request:close":
      case "request:toolResult":
      case "request:channelSubscribe":
      case "request:channelPublish":
        if (this.elector.isLeader) {
          this.handleFollowerRequest(msg);
        }
        break;
    }
  }

  private handleIncomingEvent(event: TransportEventData): void {
    // Only dispatch if this tab cares about this session
    const sessionId = event.sessionId;
    if (sessionId && !this.mySessionSubscriptions.has(sessionId)) {
      // Check if it's a channel event for a channel we're subscribed to
      if (event.type === "channel" && event.channel) {
        const channelKey = `${sessionId}:${event.channel}`;
        if (!this.myChannelSubscriptions.has(channelKey)) {
          return; // We don't care about this
        }
      } else {
        return; // We don't care about this session
      }
    }

    // Dispatch to handlers
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (e) {
        console.error("Error in event handler:", e);
      }
    }
  }

  private handleStreamEvent(requestId: string, event: TransportEventData): void {
    const stream = this.pendingStreams.get(requestId);
    if (stream && !stream.aborted) {
      stream.events.push(event);
    }
  }

  private handleStreamEnd(requestId: string): void {
    const stream = this.pendingStreams.get(requestId);
    if (stream) {
      stream.resolve();
    }
  }

  private handleStreamError(requestId: string, error: string): void {
    const stream = this.pendingStreams.get(requestId);
    if (stream) {
      stream.reject(new Error(error));
    }
  }

  private handleResponse(msg: {
    requestId: string;
    ok: boolean;
    result?: unknown;
    error?: string;
  }): void {
    const pending = this.pendingRequests.get(msg.requestId);
    if (pending) {
      this.pendingRequests.delete(msg.requestId);
      if (msg.ok) {
        pending.resolve(msg.result);
      } else {
        pending.reject(new Error(msg.error ?? "Request failed"));
      }
    }
  }

  private async handleFollowerRequest(msg: BridgeMessage): Promise<void> {
    // Extract requestId for error handling (all request types have it)
    const requestId = (msg as { requestId?: string }).requestId;
    if (!requestId) return;

    // If transport not ready, send error back to follower
    if (!this.realTransport) {
      if (msg.type === "request:send") {
        this.bridge.broadcast({
          type: "stream:error",
          requestId,
          error: "Leader transport not ready",
        });
      } else {
        this.sendResponse(requestId, false, "Leader transport not ready");
      }
      return;
    }

    try {
      switch (msg.type) {
        case "request:send": {
          // Stream send - forward events back to the specific tab
          const stream = this.realTransport.send(msg.input, msg.sessionId);
          try {
            for await (const event of stream) {
              this.bridge.broadcast({
                type: "stream:event",
                requestId,
                event,
              });
            }
            this.bridge.broadcast({ type: "stream:end", requestId });
          } catch (error) {
            this.bridge.broadcast({
              type: "stream:error",
              requestId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          break;
        }

        case "request:subscribe":
          await this.realTransport.subscribeToSession(msg.sessionId);
          this.sendResponse(requestId, true);
          break;

        case "request:unsubscribe":
          await this.realTransport.unsubscribeFromSession(msg.sessionId);
          this.sendResponse(requestId, true);
          break;

        case "request:abort":
          await this.realTransport.abortSession(msg.sessionId, msg.reason);
          this.sendResponse(requestId, true);
          break;

        case "request:close":
          await this.realTransport.closeSession(msg.sessionId);
          this.sendResponse(requestId, true);
          break;

        case "request:toolResult":
          await this.realTransport.submitToolResult(msg.sessionId, msg.toolUseId, msg.result);
          this.sendResponse(requestId, true);
          break;

        case "request:channelSubscribe":
          await this.realTransport.subscribeToChannel(msg.sessionId, msg.channel);
          this.sendResponse(requestId, true);
          break;

        case "request:channelPublish":
          await this.realTransport.publishToChannel(msg.sessionId, msg.channel, msg.event);
          this.sendResponse(requestId, true);
          break;
      }
    } catch (error) {
      this.sendResponse(requestId, false, error instanceof Error ? error.message : String(error));
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Internal: Helpers
  // ══════════════════════════════════════════════════════════════════════════

  private setState(state: TransportState): void {
    if (this._state !== state) {
      this._state = state;
      for (const handler of this.stateHandlers) {
        try {
          handler(state);
        } catch (e) {
          console.error("Error in state handler:", e);
        }
      }
    }
  }

  private async forwardRequest(
    type: BridgeMessage["type"],
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const requestId = generateRequestId(this.elector.tabId);

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });

      this.bridge.broadcast({
        type,
        requestId,
        tabId: this.elector.tabId,
        ...params,
      } as BridgeMessage);

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error("Request timed out"));
        }
      }, 30000);
    });
  }

  private sendResponse(requestId: string, ok: true, result?: unknown): void;
  private sendResponse(requestId: string, ok: false, error: string): void;
  private sendResponse(requestId: string, ok: boolean, resultOrError?: unknown): void {
    if (ok) {
      this.bridge.broadcast({ type: "response", requestId, ok: true, result: resultOrError });
    } else {
      this.bridge.broadcast({
        type: "response",
        requestId,
        ok: false,
        error: resultOrError as string,
      });
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createSharedTransport(config: SharedTransportConfig): SharedTransport {
  return new SharedTransport(config);
}
