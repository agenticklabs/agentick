/**
 * Runtime signal family — `log` + `progress` firewall types (ADR 64).
 *
 * Signals are **out-of-band diagnostics + liveness**, orthogonal to
 * model-IR content. A component (a tool via `ctx.log` / `ctx.progress`,
 * or any harness via the shared `BaseHarness` emit helpers) produces
 * ONE structured event on the bus; it is NOT sent to any wire directly.
 * Projections subscribe: the MCP-server projection forwards to
 * `notifications/message` + `notifications/progress`; the agentick
 * client receives via the existing subscribe / progress infra.
 *
 * **Emit once (framework), receive everywhere (MCP + app).**
 *
 * These are firewall types — they cross the wire to the client, so they
 * live in `@agentick/spec-next` (the shared vocabulary), NOT in any
 * harness package.
 *
 * @see docs/proposals/v2/blueprint/64-runtime-signal-family.md
 */

import type { EventQuery } from "./events.js";

// ============================================================================
// Level + token wire types
// ============================================================================

/**
 * Syslog-derived severity levels, ordered least→most severe. Mirrors
 * the MCP wire `logging/setLevel` + `notifications/message` `level`
 * enum, but is a framework-general type — every surface's `ctx.log`
 * uses it, not just MCP. `McpLogLevel` is a re-export alias of this
 * (one source of truth).
 */
export type LogLevel =
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "critical"
  | "alert"
  | "emergency";

/**
 * Progress correlation token. Matches the MCP wire type
 * (`notifications/progress` `progressToken`): a string or number chosen
 * by the caller that ties a stream of progress updates to one logical
 * operation.
 */
export type ProgressToken = string | number;

// ============================================================================
// Event payloads
// ============================================================================

/**
 * Payload of a `log` signal event. Rides the bus event envelope's
 * `payload` field under the canonical `<surface>:signal:log` name.
 *
 * - `level`  — syslog severity; projections apply their own threshold.
 * - `data`   — arbitrary JSON-serializable diagnostic payload.
 * - `logger` — optional logical channel name (the MCP wire `logger`).
 */
export interface LogEventPayload {
  readonly level: LogLevel;
  readonly data: unknown;
  readonly logger?: string;
}

/**
 * Payload of a `progress` signal event. Rides the bus event envelope's
 * `payload` field under the canonical `<surface>:signal:progress` name.
 *
 * - `token`    — correlation token (echoed onto the wire `progressToken`).
 * - `progress` — monotonic progress amount so far.
 * - `total`    — optional upper bound; absent for indeterminate work.
 * - `message`  — optional human-readable status.
 */
export interface ProgressEventPayload {
  readonly token: ProgressToken;
  readonly progress: number;
  readonly total?: number;
  readonly message?: string;
}

// ============================================================================
// Canonical name domain — `<surface>:signal:<action>`
// ============================================================================

/**
 * Event-name domain for the signal family. Signal event names are
 * `<surface>:signal:log` / `<surface>:signal:progress` — the middle
 * segment is always `"signal"`, distinguishing diagnostics from
 * operation-lifecycle (`command`), channel (`channel`), and other
 * domains.
 */
export const SIGNAL_NAME_DOMAIN = "signal" as const;

/** Canonical `log` signal event name for a given emitting surface. */
export function logEventName(surface: string): string {
  return `${surface}:${SIGNAL_NAME_DOMAIN}:log`;
}

/** Canonical `progress` signal event name for a given emitting surface. */
export function progressEventName(surface: string): string {
  return `${surface}:${SIGNAL_NAME_DOMAIN}:progress`;
}

/**
 * Subscriber-side query matching `log` signal events across ALL
 * surfaces. Uses the `wildcard` {@link NameQuery} mode — `"*"` matches
 * exactly one segment — so `*:signal:log` matches `tool:signal:log`,
 * `mcp:signal:log`, `session:signal:log`, … regardless of the emitting
 * surface. Combine with a `scope` filter (e.g. `{ sessionId }` or
 * `{ mcpConnectionId }`) to narrow to one connection / session.
 *
 * @verifiedBy packages-next/spec/src/__tests__/signals.spec.ts
 */
export function logEventQuery(): EventQuery {
  return { name: { wildcard: `*:${SIGNAL_NAME_DOMAIN}:log` } };
}

/**
 * Subscriber-side query matching `progress` signal events across ALL
 * surfaces. See {@link logEventQuery} for the wildcard semantics.
 *
 * @verifiedBy packages-next/spec/src/__tests__/signals.spec.ts
 */
export function progressEventQuery(): EventQuery {
  return { name: { wildcard: `*:${SIGNAL_NAME_DOMAIN}:progress` } };
}
