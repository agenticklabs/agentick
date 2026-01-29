/**
 * Convenience function to start DevTools server
 */
import { DevToolsServer, type DevToolsServerConfig } from "./devtools-server.js";

/**
 * Start a DevTools server.
 *
 * @example
 * ```typescript
 * import { startDevToolsServer } from '@tentickle/devtools';
 *
 * const server = startDevToolsServer({ port: 3001, debug: true });
 * console.log(`DevTools: ${server.getUrl()}`);
 *
 * // Later...
 * server.stop();
 * ```
 */
export function startDevToolsServer(config?: DevToolsServerConfig): DevToolsServer {
  const server = new DevToolsServer(config);
  server.start();
  return server;
}
