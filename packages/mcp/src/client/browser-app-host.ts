/// <reference lib="dom" />

/**
 * Browser MCP App Host
 *
 * Standalone, framework-agnostic browser class that manages MCP App iframes.
 * Handles the full client-side flow:
 *
 *   - Creates sandboxed iframes from `tool_result_start.ui` events
 *   - Publishes `mcp-app:mount` to the server session so AppBridge is created
 *   - Relays PostMessages iframe ↔ session channel `mcp-app:{appSessionId}`
 *   - Publishes `mcp-app:unmount` on teardown
 *
 * Pluggable transport abstraction — use it with any channel-compatible
 * connection (agentick gateway client, WebSocket, custom bridge, etc.).
 *
 * ```typescript
 * const host = new BrowserMCPAppHost({ transport });
 *
 * // Mount an app from a tool_result_start event
 * const handle = await host.mount(containerElement, {
 *   appSessionId: event.ui.appSessionId,
 *   resourceUri: event.ui.resourceUri,
 *   serverName: "knowify",   // which MCP server owns this
 *   content: event.ui.content, // the HTML
 * });
 *
 * // Later
 * await handle.close();
 * ```
 */

import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Minimal channel event shape — matches agentick's ChannelEvent.
 * Intentionally loose so consumers can adapt to their transport.
 */
export interface AppHostChannelEvent {
  type: string;
  channel: string;
  id?: string;
  payload: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * Transport abstraction. Consumers implement this over their gateway/WS/etc.
 * Publish sends an event to the server session. Subscribe receives events
 * the server publishes on this channel (e.g., via SSE/WS stream).
 */
export interface AppHostTransport {
  /** Send an event to the server-side channel. */
  publish(channel: string, event: AppHostChannelEvent): void | Promise<void>;

  /** Subscribe to a server channel. Returns unsubscribe function. */
  subscribe(channel: string, handler: (event: AppHostChannelEvent) => void): () => void;
}

/** Options for mounting a single app instance. */
export interface MountAppOptions {
  /** Unique ID for this app instance (from tool_result_start.ui.appSessionId) */
  appSessionId: string;
  /** Resource URI of the app (from tool_result_start.ui.resourceUri) */
  resourceUri: string;
  /** MCP server name that owns this app */
  serverName: string;
  /** Pre-resolved HTML content (from tool_result_start.ui.content) */
  content: string;
  /**
   * Iframe sandbox attribute value. Default: "allow-scripts allow-same-origin".
   * Per MCP Apps spec defaults for iframe isolation.
   */
  sandbox?: string;
  /**
   * Iframe allow attribute (permissions policy). Default: none.
   * Use for apps that need camera/microphone/geolocation/etc.
   */
  allow?: string;
  /**
   * Host capabilities to advertise during ui/initialize.
   * Forwarded to the server-side AppBridge.
   */
  hostCapabilities?: Record<string, unknown>;
}

/** Handle to a mounted app instance. */
export interface MountedApp {
  readonly appSessionId: string;
  readonly iframe: HTMLIFrameElement;
  /** Tear down the iframe and notify the server. */
  close(): Promise<void>;
}

export interface BrowserMCPAppHostOptions {
  /** Transport for publishing to / subscribing from session channels */
  transport: AppHostTransport;
}

// ============================================================================
// Internal state per mounted app
// ============================================================================

interface AppState {
  appSessionId: string;
  iframe: HTMLIFrameElement;
  channelName: string;
  unsubChannel: () => void;
  unsubPostMessage: () => void;
  closed: boolean;
}

// ============================================================================
// BrowserMCPAppHost
// ============================================================================

export class BrowserMCPAppHost {
  private readonly transport: AppHostTransport;
  private readonly apps = new Map<string, AppState>();

  constructor(options: BrowserMCPAppHostOptions) {
    this.transport = options.transport;
  }

  /**
   * Mount an app in the given container element.
   * Creates the iframe, wires PostMessage ↔ channel relay, notifies the server.
   */
  async mount(container: HTMLElement, options: MountAppOptions): Promise<MountedApp> {
    const { appSessionId, resourceUri, serverName, content } = options;

    if (this.apps.has(appSessionId)) {
      throw new Error(`App session "${appSessionId}" is already mounted`);
    }

    // ── Create sandboxed iframe ──
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", options.sandbox ?? "allow-scripts allow-same-origin");
    if (options.allow) {
      iframe.setAttribute("allow", options.allow);
    }
    // srcdoc lets us inject HTML without needing a URL
    iframe.srcdoc = content;
    iframe.style.border = "none";
    iframe.style.width = "100%";
    container.appendChild(iframe);

    // Wait for iframe to load so contentWindow exists and PostMessage works
    await new Promise<void>((resolve, reject) => {
      const onLoad = () => {
        iframe.removeEventListener("load", onLoad);
        iframe.removeEventListener("error", onError);
        resolve();
      };
      const onError = () => {
        iframe.removeEventListener("load", onLoad);
        iframe.removeEventListener("error", onError);
        reject(new Error(`Iframe failed to load for app ${appSessionId}`));
      };
      iframe.addEventListener("load", onLoad);
      iframe.addEventListener("error", onError);
    });

    const channelName = `mcp-app:${appSessionId}`;

    // ── Wire channel → iframe (server "to-app" → PostMessage to iframe) ──
    const unsubChannel = this.transport.subscribe(channelName, (event) => {
      if (event.type !== "to-app") return;
      const payload = event.payload as JSONRPCMessage;
      iframe.contentWindow?.postMessage(payload, "*");
    });

    // ── Wire iframe → channel (PostMessage from iframe → publish "to-server") ──
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframe.contentWindow) return;
      this.transport.publish(channelName, {
        type: "to-server",
        channel: channelName,
        payload: e.data as JSONRPCMessage,
      });
    };
    window.addEventListener("message", onMessage);
    const unsubPostMessage = () => window.removeEventListener("message", onMessage);

    // ── Publish mount to server → AppBridge is created server-side ──
    await this.transport.publish("mcp-app:mount", {
      type: "mount",
      channel: "mcp-app:mount",
      payload: {
        appSessionId,
        resourceUri,
        serverName,
        hostCapabilities: options.hostCapabilities,
      },
    });

    // ── Track state ──
    const state: AppState = {
      appSessionId,
      iframe,
      channelName,
      unsubChannel,
      unsubPostMessage,
      closed: false,
    };
    this.apps.set(appSessionId, state);

    const handle: MountedApp = {
      appSessionId,
      iframe,
      close: () => this.unmount(appSessionId),
    };
    return handle;
  }

  /**
   * Unmount an app by sessionId. Tears down the iframe and notifies the server.
   */
  async unmount(appSessionId: string): Promise<void> {
    const state = this.apps.get(appSessionId);
    if (!state || state.closed) return;
    state.closed = true;

    // Stop channel + PostMessage relays first so no more messages flow
    state.unsubChannel();
    state.unsubPostMessage();

    // Notify server to tear down the bridge
    try {
      await this.transport.publish("mcp-app:unmount", {
        type: "unmount",
        channel: "mcp-app:unmount",
        payload: { appSessionId },
      });
    } catch {
      // Best-effort — server might be unreachable
    }

    // Remove the iframe from the DOM
    state.iframe.parentNode?.removeChild(state.iframe);
    this.apps.delete(appSessionId);
  }

  /** Get a handle to a currently-mounted app. */
  get(appSessionId: string): MountedApp | undefined {
    const state = this.apps.get(appSessionId);
    if (!state || state.closed) return undefined;
    return {
      appSessionId: state.appSessionId,
      iframe: state.iframe,
      close: () => this.unmount(state.appSessionId),
    };
  }

  /** List all currently-mounted app session IDs. */
  list(): string[] {
    return Array.from(this.apps.keys()).filter((id) => !this.apps.get(id)?.closed);
  }

  /** Tear down all mounted apps. */
  async close(): Promise<void> {
    const ids = Array.from(this.apps.keys());
    await Promise.all(ids.map((id) => this.unmount(id)));
  }
}
