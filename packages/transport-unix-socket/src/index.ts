/**
 * `@agentick/transport-unix-socket` — newline-delimited JSON-RPC
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
  unixSocketServerTransport,
  type DispatchHost,
  type UnixSocketFailure,
  type UnixSocketFailureSite,
  type UnixSocketServerHandle,
  type UnixSocketServerOptions,
  type UnixSocketServerTransportConfig,
} from "./server/index.js";
export {
  DEFAULT_MAX_LINE_BYTES,
  NdjsonDecoder,
  encodeNdjson,
  type NdjsonDecoderOptions,
  type NdjsonResult,
} from "./shared/ndjson.js";
