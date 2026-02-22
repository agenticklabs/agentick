/**
 * @agentick/gateway
 *
 * Standalone daemon for multi-client, multi-agent access.
 * Supports both WebSocket and HTTP/SSE transports.
 */

// Main exports
export { Gateway, createGateway } from "./gateway.js";
export { AppRegistry } from "./app-registry.js";
export { SessionManager } from "./session-manager.js";

// Transport layer
export {
  type Transport,
  type TransportClient,
  type TransportConfig,
  type NetworkTransportConfig,
  type TransportEvents,
  BaseTransport,
} from "./transport.js";
export { WSTransport, createWSTransport } from "./ws-transport.js";
export { HTTPTransport, createHTTPTransport, type HTTPTransportConfig } from "./http-transport.js";
export { LocalGatewayTransport } from "./local-transport.js";
export { UnixSocketTransport, type UnixSocketTransportConfig } from "./unix-socket-transport.js";
export {
  createUnixSocketClientTransport,
  type UnixSocketClientConfig,
} from "./unix-socket-client-transport.js";

// Testing utilities: import from "@agentick/gateway/testing" — not re-exported
// here to avoid pulling vitest into production bundles.

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
  type AppsPayload,
  type SessionsPayload,
} from "./transport-protocol.js";

// Configuration types
export {
  type GatewayConfig,
  type AuthConfig,
  type AuthResult,
  type StorageConfig,
  type GatewayHandle,
  type GatewayPlugin,
  type PluginContext,
  type ClientState,
  type SessionState,
  type GatewayEvents,
  type UserContext,
  // Method types
  type MethodDefinition,
  type MethodDefinitionInput,
  type MethodNamespace,
  type MethodsConfig,
  type Method,
  type SimpleMethodHandler,
  type StreamingMethodHandler,
  // Method factory
  method,
  isMethodDefinition,
  METHOD_DEFINITION,
  // Schema type for Zod 3/4 compatibility
  type ZodLikeSchema,
} from "./types.js";
