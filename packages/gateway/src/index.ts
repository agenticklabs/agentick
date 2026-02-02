/**
 * @tentickle/gateway
 *
 * Standalone daemon for multi-client, multi-agent access.
 * Supports both WebSocket and HTTP/SSE transports.
 */

// Main exports
export { Gateway, createGateway } from "./gateway.js";
export { AgentRegistry } from "./agent-registry.js";
export { SessionManager } from "./session-manager.js";

// Transport layer
export {
  type Transport,
  type TransportClient,
  type TransportConfig,
  type TransportEvents,
  BaseTransport,
} from "./transport.js";
export { WSTransport, createWSTransport } from "./ws-transport.js";
export { HTTPTransport, createHTTPTransport, type HTTPTransportConfig } from "./http-transport.js";

// Legacy export for backward compatibility
export { WSTransport as WSServer } from "./ws-transport.js";
export type { TransportClient as WSClient } from "./transport.js";

// Testing utilities
export {
  createTestGateway,
  createMockApp,
  waitForGatewayEvent,
  type TestGatewayOptions,
  type TestGatewayClient,
  type TestGatewayResult,
  type MockAppOptions,
} from "./testing.js";

// Protocol types
export {
  parseSessionKey,
  formatSessionKey,
  type SessionKey,
  type ClientMessage,
  type GatewayMessage,
  type ConnectMessage,
  type RequestMessage,
  type ResponseMessage,
  type EventMessage,
  type GatewayMethod,
  type GatewayEventType,
  type SendParams,
  type StatusParams,
  type HistoryParams,
  type StatusPayload,
  type AgentsPayload,
  type SessionsPayload,
} from "./protocol.js";

// Configuration types
export {
  type GatewayConfig,
  type AuthConfig,
  type AuthResult,
  type StorageConfig,
  type ChannelAdapter,
  type GatewayContext,
  type SessionContext,
  type SessionEvent,
  type RoutingConfig,
  type IncomingMessage,
  type RoutingContext,
  type ClientState,
  type SessionState,
  type GatewayEvents,
} from "./types.js";
