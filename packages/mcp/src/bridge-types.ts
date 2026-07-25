/**
 * Type for the `bridges.mcp` slot exposed by `withMCP({ servers })`.
 *
 * Lookup by `serverId` returns the per-(session, server)
 * `McpClientHarness` directly — the single class owns the
 * connection-status FSM, lifecycle verbs, and the wire-level
 * operations. In-tree JSX consumers reach it via
 * `useBridges().mcp?.client("linear")` and call any of the verbs
 * (`connect` / `disconnect` / `reconnect` / `reauthenticate`) or
 * read `status` / subscribe via `onStatusChange`. Tool dispatch
 * goes through the canonical `session.tools.dispatch("<serverId>__<tool>", ...)`
 * path — no need to reach into the harness's wire ops directly.
 *
 * The `clients` array gives bulk access for surfaces that want to
 * enumerate (status dashboards, health UIs).
 */

import type { McpClientHarness } from "./client/harness.js";

export interface McpHookBridge {
  /** Look up a client by server id. Returns undefined if not registered. */
  readonly client: (serverId: string) => McpClientHarness | undefined;
  /** All registered clients (snapshot — not reactive). */
  readonly clients: ReadonlyArray<McpClientHarness>;
}
