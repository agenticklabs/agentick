/**
 * DevTools Package
 *
 * Provides real-time observability for Agentick applications:
 * - SSE server for streaming events to UI
 * - HTTP API for querying execution history
 * - Subscribes to devToolsEmitter for fiber snapshots and execution events
 */

export { DevToolsServer, type DevToolsServerConfig } from "./server/devtools-server.js";
export { startDevToolsServer } from "./server/start.js";
