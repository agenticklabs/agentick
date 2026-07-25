/**
 * `McpConnectionStatus` — per-server connection state surfaced to
 * adopter UIs. Read via `McpClientHarness.status`; subscribe to
 * transitions via `McpClientHarness.onStatusChange`.
 *
 * The states are **credentials-shaped**, not UI-shaped. There is no
 * `auth-required` state that fires elicit — the UI decides what to
 * do with `credentials-missing` / `credentials-expired` (typically
 * render a "Connect" button that calls `reauthenticate()`).
 *
 * Session-start optimistic-connect flow (#277):
 *
 *     disconnected
 *          │ connect() — withMCP eagerly calls this at session boot
 *          ▼
 *     connecting
 *          │
 *          ├──── credentials present + accepted ────▶ connected
 *          │
 *          ├──── credentials absent ────────────────▶ credentials-missing
 *          │
 *          ├──── credentials rejected / refresh fail ▶ credentials-expired
 *          │
 *          └──── transport / network failure ───────▶ error
 *
 * `reauthenticate()` is the ONLY caller-side path that fires the
 * OAuth elicit. `connect()` / `reconnect()` use whatever the
 * credentials store has and surface failures as status, not UI
 * prompts.
 *
 * @see #277 — MCP connection-status surface (parent design)
 */

/**
 * Discriminated union — branch on `kind` to access state-specific
 * fields.
 */
export type McpConnectionStatus =
  | { readonly kind: "disconnected" }
  | { readonly kind: "connecting" }
  | { readonly kind: "connected" }
  | { readonly kind: "credentials-missing" }
  | { readonly kind: "credentials-expired"; readonly reason?: string }
  | { readonly kind: "error"; readonly reason: string };

/**
 * Subscription token returned by `onStatusChange`. Call to unsubscribe.
 * Matches the framework's `Unsubscribe` shape (see
 * `@agentick/spec` substrate types).
 */
export type StatusUnsubscribe = () => void;

/**
 * Terminal-status helper — `true` for any non-transitional state.
 * Useful in tests + UI reducers that wait for "settled" status.
 */
export function isTerminalStatus(status: McpConnectionStatus): boolean {
  switch (status.kind) {
    case "connecting":
      return false;
    case "disconnected":
    case "connected":
    case "credentials-missing":
    case "credentials-expired":
    case "error":
      return true;
  }
}
