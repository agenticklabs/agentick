/**
 * Structured-logging projection — the server side of MCP logging.
 *
 * Two moving parts, both connection-scoped:
 *
 *   1. `logging/setLevel` request handler — the client tells the server
 *      the minimum severity it wants; we store it in a per-connection
 *      {@link ConnectionLogState} holder.
 *   2. `ctx.log(level, data, logger?)` sink — tool / prompt / completion
 *      handlers running in the MCP-server context emit diagnostics that
 *      surface to the client as `notifications/message`, filtered
 *      against the level the client set.
 *
 * Level filtering follows syslog severity ordering: a message at level
 * L is emitted iff `severity(L) >= severity(currentLevel)`. Before the
 * client issues any `logging/setLevel`, the holder defaults to `debug`
 * (emit everything) — the MCP spec lets the server decide the default,
 * and "emit until told otherwise" is the least-surprising choice for
 * diagnostics.
 *
 * **v1 origin:** v1 advertised `logging: {}` but never registered a
 * `setLevel` handler nor emitted server-side messages. This wires the
 * missing half — SDK `SetLevelRequestSchema` + `sendLoggingMessage`.
 */

import type { Server as SdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import type { LoggingMessageNotification } from "@modelcontextprotocol/sdk/types.js";
import { SetLevelRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpLogLevel, McpLogSink } from "@agentick/spec-next";

/**
 * Syslog-derived severity ranking, least→most severe. Drives the
 * `ctx.log` level filter. Mirrors the wire `LoggingLevel` enum order.
 */
export const LOG_LEVEL_SEVERITY: Readonly<Record<McpLogLevel, number>> = {
  debug: 0,
  info: 1,
  notice: 2,
  warning: 3,
  error: 4,
  critical: 5,
  alert: 6,
  emergency: 7,
};

/**
 * Per-connection log-level holder. Mutated in place by the
 * `logging/setLevel` handler; read by the {@link McpLogSink} on every
 * emit. Defaults to `debug` (emit everything) until the client sets a
 * level.
 */
export interface ConnectionLogState {
  level: McpLogLevel;
}

/** Fresh holder for a new connection, defaulting to `debug`. */
export function createConnectionLogState(): ConnectionLogState {
  return { level: "debug" };
}

/**
 * Register the `logging/setLevel` request handler on the SDK Server.
 * The handler stores the client's requested level into `state`; the
 * empty result is the spec-mandated ack.
 *
 * MUST only be called when the `logging` capability is advertised —
 * the SDK's `assertRequestHandlerCapability` throws otherwise.
 */
export function installLoggingHandler(sdkServer: SdkServer, state: ConnectionLogState): void {
  sdkServer.setRequestHandler(SetLevelRequestSchema, async (request) => {
    state.level = request.params.level;
    return {};
  });
}

/**
 * Build the `ctx.log` sink for one connection. Emits a
 * `notifications/message` per call, dropping any message below the
 * currently-set level. Fire-and-forget: a send failure (connection
 * closed mid-flight) is swallowed — logging is never a control path.
 *
 * MUST only be attached when the `logging` capability is advertised —
 * the SDK's `assertNotificationCapability` throws otherwise.
 */
export function buildMcpLog(sdkServer: SdkServer, state: ConnectionLogState): McpLogSink {
  return (level, data, logger) => {
    if (LOG_LEVEL_SEVERITY[level] < LOG_LEVEL_SEVERITY[state.level]) return;
    const params: LoggingMessageNotification["params"] =
      logger !== undefined ? { level, logger, data } : { level, data };
    void sdkServer.sendLoggingMessage(params).catch(() => {
      // Connection probably closed mid-notification — silently drop.
    });
  };
}
