/**
 * Unix Socket Client Transport
 *
 * Returns a ClientTransport that connects to a gateway over a Unix domain socket.
 * Lives in the gateway package (not client) because node:net is Node-only and
 * the client package must remain browser-compatible.
 *
 * This is a thin delegate over the shared createRPCTransport. The only
 * wire-specific logic is: open a net.Socket, frame messages as NDJSON.
 */

import net from "node:net";
import type { ClientTransport } from "@agentick/shared";
import { createRPCTransport } from "@agentick/shared";
import { LineBuffer } from "./ndjson.js";

// ============================================================================
// Configuration
// ============================================================================

export interface UnixSocketClientConfig {
  /** Path to the Unix domain socket */
  socketPath: string;

  /** Client ID (auto-generated if not provided) */
  clientId?: string;

  /** Authentication token */
  token?: string;

  /** Reconnection settings */
  reconnect?: {
    enabled?: boolean;
    maxAttempts?: number;
    delay?: number;
  };

  /** Request timeout in ms (default: 30000) */
  timeout?: number;

  /** Connection timeout in ms (default: 5000) */
  connectTimeout?: number;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a ClientTransport that connects to a gateway over a Unix domain socket.
 */
export function createUnixSocketClientTransport(config: UnixSocketClientConfig): ClientTransport {
  const connectTimeout = config.connectTimeout ?? 5000;

  return createRPCTransport(
    {
      clientId: config.clientId,
      token: config.token,
      timeout: config.timeout,
      reconnect: config.reconnect,
    },
    {
      open(callbacks) {
        return new Promise((resolve, reject) => {
          let settled = false;

          const timer = setTimeout(() => {
            if (!settled) {
              settled = true;
              socket.destroy();
              reject(new Error(`Connection to ${config.socketPath} timed out`));
            }
          }, connectTimeout);

          const socket = net.connect(config.socketPath);
          const lineBuffer = new LineBuffer();

          socket.on("connect", () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);

            resolve({
              send(data: Record<string, unknown>) {
                if (!socket.destroyed && socket.writable) {
                  socket.write(JSON.stringify(data) + "\n");
                }
              },
              close() {
                socket.destroy();
              },
            });
          });

          socket.on("data", (data) => {
            const lines = lineBuffer.feed(data.toString());
            for (const line of lines) {
              try {
                callbacks.onMessage(JSON.parse(line));
              } catch (error) {
                console.error("Failed to parse Unix socket message:", error);
              }
            }
          });

          socket.on("error", (error) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(error);
            } else {
              callbacks.onError(error);
            }
          });

          socket.on("close", () => {
            if (settled) {
              callbacks.onClose();
            }
          });
        });
      },
    },
  );
}
