/**
 * Transport implementations for @tentickle/client
 *
 * Default: HTTP/SSE transport
 * Alternative: WebSocket transport
 *
 * Both transports support custom implementations for:
 * - Server-side (Node.js) usage with polyfills
 * - Custom HTTP clients (axios, ky, got)
 * - Testing with mocks
 *
 * @module @tentickle/client/transports
 */

// Default HTTP/SSE transport
export {
  HTTPTransport,
  createHTTPTransport,
  type HTTPTransportConfig,
  type FetchFn,
  type EventSourceConstructor,
} from "./http.js";

// Alternative WebSocket transport
export {
  WebSocketTransport,
  createWebSocketTransport,
  type WebSocketConfig,
  type WebSocketConstructor,
} from "./websocket.js";
