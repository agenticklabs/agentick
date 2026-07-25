/**
 * Structured-logging + progress projection — the server side of the
 * runtime signal family (ADR 64).
 *
 * Wave 3a shipped a direct sink: `ctx.log` called
 * `sdkServer.sendLoggingMessage` inline, so a tool's log went NOWHERE
 * unless it ran as an MCP server. ADR 64 reworks this. Now `ctx.log` /
 * `ctx.progress` emit ONE discrete bus event (`<surface>:signal:log` /
 * `<surface>:signal:progress`), and THIS module is a **bus subscriber**
 * that forwards matching events to the wire. Same behavior on the wire;
 * the source moved to the framework seam so every consumer (MCP client,
 * agentick client, observability) receives the same emit.
 *
 * Three connection-scoped moving parts:
 *
 *   1. `logging/setLevel` request handler — the client tells the server
 *      the minimum severity it wants; stored in a per-connection
 *      {@link ConnectionLogState} holder.
 *   2. {@link installLogProjection} — subscribes to `log` bus events
 *      scoped to THIS connection and forwards to `notifications/message`,
 *      filtered against the level the client set.
 *   3. {@link installProgressProjection} — subscribes to `progress` bus
 *      events scoped to this connection and forwards to
 *      `notifications/progress` (progress is not capability-gated in the
 *      MCP spec — no `setLevel` equivalent).
 *
 * Level filtering follows syslog severity ordering: a message at level
 * L is emitted iff `severity(L) >= severity(currentLevel)`. Before the
 * client issues any `logging/setLevel`, the holder defaults to `debug`
 * (emit everything) — the MCP spec lets the server decide the default,
 * and "emit until told otherwise" is the least-surprising choice for
 * diagnostics.
 *
 * @see docs/proposals/v2/blueprint/64-runtime-signal-family.md
 */

import type { Server as SdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import type { LoggingMessageNotification } from "@modelcontextprotocol/sdk/types.js";
import { SetLevelRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  EventBus,
  EventScope,
  LogEventPayload,
  McpLogLevel,
  ProgressEventPayload,
  Unsubscribe,
} from "@agentick/spec";
import { logEventQuery, progressEventQuery } from "@agentick/spec";
import { forkBusSubscription } from "@agentick/runtime";

/**
 * Syslog-derived severity ranking, least→most severe. Drives the log
 * level filter. Mirrors the wire `LoggingLevel` enum order.
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
 * `logging/setLevel` handler; read by {@link installLogProjection} on
 * every event. Defaults to `debug` (emit everything) until the client
 * sets a level.
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
 * Subscribe to `log` bus events scoped to one connection and forward
 * each to `notifications/message`, dropping any message below the
 * currently-set level. Returns an {@link Unsubscribe} that tears down
 * the subscription (push onto the connection's cleanup list).
 *
 * Fire-and-forget: a send failure (connection closed mid-notification)
 * is swallowed — logging is never a control path. Per-event errors are
 * isolated by {@link forkBusSubscription} so one bad event can't stop
 * delivery.
 *
 * MUST only be installed when the `logging` capability is advertised —
 * the SDK's `assertNotificationCapability` throws on
 * `sendLoggingMessage` otherwise.
 *
 * @verifiedBy packages/mcp/src/server/__tests__/projection-completions-logging.spec.ts
 */
export function installLogProjection(args: {
  readonly sdkServer: SdkServer;
  readonly state: ConnectionLogState;
  readonly bus: EventBus;
  readonly connectionScope: Partial<EventScope>;
}): Unsubscribe {
  const { sdkServer, state, bus, connectionScope } = args;
  return forkBusSubscription(bus, { ...logEventQuery(), scope: connectionScope }, (event) => {
    const payload = event.payload as LogEventPayload | undefined;
    if (payload === undefined) return;
    if (LOG_LEVEL_SEVERITY[payload.level] < LOG_LEVEL_SEVERITY[state.level]) return;
    const params: LoggingMessageNotification["params"] =
      payload.logger !== undefined
        ? { level: payload.level, logger: payload.logger, data: payload.data }
        : { level: payload.level, data: payload.data };
    void sdkServer.sendLoggingMessage(params).catch(() => {
      // Connection probably closed mid-notification — silently drop.
    });
  });
}

/**
 * Subscribe to `progress` bus events scoped to one connection and
 * forward each to `notifications/progress`. Returns an
 * {@link Unsubscribe}.
 *
 * Progress carries no per-connection level filter (unlike logging, it
 * has no `setLevel` in the MCP spec) and no capability gate, so this is
 * installed unconditionally per connection. Same fire-and-forget +
 * swallow-on-closed behavior as {@link installLogProjection}.
 *
 * @verifiedBy packages/mcp/src/server/__tests__/progress.spec.ts
 */
export function installProgressProjection(args: {
  readonly sdkServer: SdkServer;
  readonly bus: EventBus;
  readonly connectionScope: Partial<EventScope>;
}): Unsubscribe {
  const { sdkServer, bus, connectionScope } = args;
  return forkBusSubscription(bus, { ...progressEventQuery(), scope: connectionScope }, (event) => {
    const payload = event.payload as ProgressEventPayload | undefined;
    if (payload === undefined) return;
    const params = {
      progressToken: payload.token,
      progress: payload.progress,
      ...(payload.total !== undefined ? { total: payload.total } : {}),
      ...(payload.message !== undefined ? { message: payload.message } : {}),
    };
    void sdkServer.notification({ method: "notifications/progress", params }).catch(() => {
      // Connection probably closed mid-notification — silently drop.
    });
  });
}
