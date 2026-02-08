/**
 * @tentickle/gateway
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
  type TransportEvents,
  BaseTransport,
} from "./transport.js";
export { WSTransport, createWSTransport } from "./ws-transport.js";
export { HTTPTransport, createHTTPTransport, type HTTPTransportConfig } from "./http-transport.js";

// Testing utilities
export {
  createTestGateway,
  createMockApp,
  createMockSession,
  createMockExecutionHandle,
  waitForGatewayEvent,
  type TestGatewayOptions,
  type TestGatewayClient,
  type TestGatewayResult,
  type MockAppOptions,
  type MockSessionOptions,
  type MockSession,
  type MockApp,
  type MockSessionExecutionHandle,
  type MockExecutionHandleOptions,
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
  type AppsPayload,
  type SessionsPayload,
} from "./transport-protocol.js";

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
