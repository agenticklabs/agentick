/**
 * WebSocket Transport
 *
 * Implements the ClientTransport interface using WebSocket connections.
 * Compatible with the Gateway's WebSocket protocol.
 *
 * Thin delegate over the shared createRPCTransport. The only wire-specific
 * logic is: open a WebSocket, send/receive JSON strings.
 */

import type { ClientTransport } from "@agentick/shared";
import { createRPCTransport } from "@agentick/shared";

// ============================================================================
// WebSocket Transport Configuration
// ============================================================================

export interface WSTransportConfig {
  /** Base URL for the server (http:// or ws://) */
  baseUrl: string;

  /** Client ID to use for connection */
  clientId?: string;

  /** Authentication token */
  token?: string;

  /** Custom headers (passed to WebSocket implementations that support them) */
  headers?: Record<string, string>;

  /** Request timeout in ms (default: 30000) */
  timeout?: number;

  /** Send credentials with requests */
  withCredentials?: boolean;

  /** WebSocket implementation (for Node.js compatibility) */
  WebSocket?: typeof WebSocket;

  /** Reconnection settings */
  reconnect?: {
    /** Enable auto-reconnection (default: true) */
    enabled?: boolean;
    /** Max reconnection attempts (default: 5) */
    maxAttempts?: number;
    /** Delay between attempts in ms (default: 1000) */
    delay?: number;
  };
}

// ============================================================================
// WebSocket Transport
// ============================================================================

export interface WSTransport extends ClientTransport {
  /** Send a ping to keep connection alive */
  ping(): void;
}

/**
 * Create a WebSocket-backed ClientTransport.
 */
export function createWSTransport(config: WSTransportConfig): WSTransport {
  const WSCtor = config.WebSocket ?? globalThis.WebSocket;
  let currentSocket: WebSocket | undefined;

  const transport = createRPCTransport(
    {
      clientId: config.clientId,
      token: config.token,
      timeout: config.timeout,
      reconnect: config.reconnect,
    },
    {
      open(callbacks) {
        // Convert http:// to ws:// or https:// to wss://
        let url = config.baseUrl.replace(/\/$/, "");
        if (url.startsWith("http://")) {
          url = url.replace("http://", "ws://");
        } else if (url.startsWith("https://")) {
          url = url.replace("https://", "wss://");
        }

        return new Promise((resolve, reject) => {
          try {
            const ws = new WSCtor(url);
            currentSocket = ws;

            ws.onopen = () => {
              resolve({
                send(data: Record<string, unknown>) {
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(data));
                  }
                },
                close() {
                  ws.close();
                  currentSocket = undefined;
                },
              });
            };

            ws.onmessage = (event) => {
              try {
                callbacks.onMessage(JSON.parse(event.data as string));
              } catch (error) {
                console.error("Failed to parse WebSocket message:", error);
              }
            };

            ws.onerror = () => {
              reject(new Error("WebSocket connection failed"));
            };

            ws.onclose = () => {
              currentSocket = undefined;
              callbacks.onClose();
            };
          } catch (error) {
            reject(error);
          }
        });
      },
    },
  ) as WSTransport;

  // Extra method not in ClientTransport — keep-alive pings
  transport.ping = () => {
    if (currentSocket?.readyState === WebSocket.OPEN) {
      currentSocket.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
    }
  };

  return transport;
}
