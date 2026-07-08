/**
 * Inbound client-roots ingest (ADR 65 — the server ← client direction).
 *
 * When a connecting client advertises the `roots` capability, the server
 * pulls its `file://` roots via `roots/list` after initialize and re-pulls
 * on `notifications/roots/list_changed`. The result is surfaced,
 * per-connection, on `ctx.mcp.clientRoots`.
 *
 * This is COMPOSITION, not a harness (ADR 65): the roots belong to the
 * connecting peer — the server only reads them; there is no local mount
 * state to own. The ingest is scoped to ONE connection (one SDK `Server`
 * instance), so connection A's roots can never appear on connection B's
 * ctx — the isolation is structural, not a filter.
 *
 * Fire-and-forget by contract: a failed `roots/list` (peer dropped, slow,
 * or lying about its capability) NEVER propagates into a request path. The
 * current value simply stays at its last-known state (or `undefined`).
 *
 * TODO(#237-4b / ADR-65): roots-registry upgrade path — if a unified,
 * inspectable, cross-source mount registry is ever needed, a RootsHarness
 * slots UNDER this seam: the ingest writes INTO it instead of onto a
 * per-connection holder, and a wire enumerate+subscribe surface is added.
 * The `current()` accessor + the ctx read survive unchanged. See ADR 65
 * for the trigger + rationale.
 *
 * @see docs/proposals/v2/blueprint/65-roots-as-projection.md
 */

import type { Server as SdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpRoot } from "@agentick/spec-next";
import type { Unsubscribe } from "@agentick/runtime-next";

/** Live per-connection view of the peer's roots + a teardown hook. */
export interface ClientRootsIngest {
  /**
   * The peer's most-recently-pulled roots, or `undefined` when the client
   * never advertised `roots` OR the first pull has not resolved yet. Read
   * fresh on each request-ctx build.
   */
  readonly current: () => readonly McpRoot[] | undefined;
  /** Detach the notification handler + stop applying in-flight pulls. */
  readonly unsubscribe: Unsubscribe;
}

/**
 * Install the client-roots ingest on a per-connection SDK `Server`.
 *
 * Registers an `oninitialized` hook (first pull, once the client's
 * capabilities are known) and a `roots/list_changed` notification handler
 * (re-pull). Both guard on the client having advertised `roots`, so
 * `sdkServer.listRoots()` never trips the SDK's capability assertion.
 */
export function installClientRootsIngest(sdkServer: SdkServer): ClientRootsIngest {
  let roots: readonly McpRoot[] | undefined;
  let closed = false;

  const pull = async (): Promise<void> => {
    // The client MUST have advertised `roots` before we call `roots/list`
    // (the SDK server asserts the capability otherwise). Post-initialize
    // this is populated; before it, we simply skip.
    const caps = sdkServer.getClientCapabilities?.();
    if (caps === undefined || caps.roots === undefined) return;
    try {
      const result = await sdkServer.listRoots();
      if (closed) return;
      roots = result.roots.map((r) =>
        r.name !== undefined ? { uri: r.uri, name: r.name } : { uri: r.uri },
      );
    } catch {
      // Fire-and-forget: a failed pull is never a control path. Leave the
      // last-known value in place (advisory scoping tolerates staleness).
    }
  };

  // `oninitialized` fires when the client's `notifications/initialized`
  // arrives — the first moment client capabilities are known. A single
  // callback slot; the server harness does not otherwise use it.
  sdkServer.oninitialized = (): void => {
    void pull();
  };
  sdkServer.setNotificationHandler(RootsListChangedNotificationSchema, () => {
    void pull();
  });

  return {
    current: () => roots,
    unsubscribe: () => {
      closed = true;
    },
  };
}
