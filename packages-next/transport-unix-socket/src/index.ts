/**
 * `@agentick/transport-unix-socket-next` — newline-delimited JSON-RPC
 * over a Node `net.Server` / `net.Socket`. Node-only; required for
 * tentickle-class local-IPC shapes (TUI ↔ same-host daemon).
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

export {
  unixSocket,
  type UnixSocketTransportOptions,
  type ReconnectPolicy,
} from "./client/index.js";
export {
  unixSocketServer,
  type UnixSocketServerOptions,
  type UnixSocketServerHandle,
  type DispatchHost,
} from "./server/index.js";
