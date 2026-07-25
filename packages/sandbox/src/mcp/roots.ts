/**
 * Sandbox → MCP roots projection (ADR 65 — outbound direction).
 *
 * A sandbox is the FLAGSHIP roots source, not a prerequisite: roots work
 * standalone from a static list or a plain provider fn (proved in the MCP
 * client tests, no sandbox in the graph). This module supplies the
 * sandbox-backed source + the live-sync binding. It lives on the sandbox
 * package's opt-in `/mcp` subpath (deps mcp + resources) so the MCP client
 * core stays decoupled from the sandbox — the dep points sandbox → mcp,
 * one direction, no cycle.
 *
 * Why the sandbox is the headline source: when a deployment IS sandboxed,
 * the boundaries you DECLARE to a peer should equal the boundaries you
 * ENFORCE (workspace + mounts), and mount changes should keep the peer in
 * sync automatically. {@link bindSandboxRootsToClient} realises the second
 * half — sandbox mount-topology change → `notifyRootsListChanged()`.
 *
 * @see docs/proposals/v2/blueprint/65-roots-as-projection.md
 */

import { basename } from "node:path";
import type { McpClientHarness, McpRoot, McpRootsSource } from "@agentick/mcp";
import type { SandboxMount } from "@agentick/spec";
import type { Unsubscribe } from "@agentick/runtime";

import type { SandboxHarness } from "../harness.js";
import { pathToFileUri } from "./uri.js";

/**
 * Build an {@link McpRootsSource} that projects a sandbox's workspace +
 * live mounts as `file://` roots. Re-evaluated on each `roots/list` (the
 * source is a provider fn), so it always reflects the current mount table.
 *
 * The workspace root is always present, named `"workspace"`. Each mount
 * contributes a root at its in-sandbox path (the boundary the agent
 * actually operates within), named by its basename. `listMounts` is
 * capability-tiered on the provider — a provider that cannot list mounts
 * degrades to workspace-only rather than failing the pull.
 *
 * TODO(#237-4b / ADR-65): roots-registry upgrade path — if a unified,
 * inspectable, cross-source mount registry is ever needed, a RootsHarness
 * slots UNDER this provider-fn seam (this source reads from it instead of
 * the sandbox; inbound writes to it; add wire enumerate+subscribe). The
 * `McpRootsSource` return shape survives unchanged. See ADR 65.
 */
export function sandboxRootsSource(sandbox: SandboxHarness): McpRootsSource {
  return async (): Promise<readonly McpRoot[]> => {
    const roots: McpRoot[] = [{ uri: pathToFileUri(sandbox.workspacePath), name: "workspace" }];
    let mounts: readonly SandboxMount[] = [];
    try {
      mounts = await sandbox.listMounts();
    } catch {
      // Capability-tiered (ADR 59): a provider without `listMounts` throws
      // `SandboxUnsupportedError`. Degrade to workspace-only — an honest
      // partial view beats failing the whole `roots/list`.
    }
    for (const mount of mounts) {
      const name = basename(mount.sandboxPath);
      roots.push({
        uri: pathToFileUri(mount.sandboxPath),
        name: name.length > 0 ? name : mount.sandboxPath,
      });
    }
    return roots;
  };
}

/**
 * Keep a connected MCP client's advertised roots in sync with a sandbox's
 * live mounts (ADR 65). Subscribes to the sandbox's mount-topology changes
 * and fires `notifyRootsListChanged()` on each, so a connected server
 * re-pulls `roots/list` (which, when the client was configured with
 * {@link sandboxRootsSource}, reflects the new mount table).
 *
 * Fire-and-forget: `notifyRootsListChanged` throws if the client is not
 * ready (mid-reconnect / closed) — swallowed here, because a dropped
 * notification is recoverable (the server re-pulls at its discretion) and
 * a mount change must never throw into the sandbox command path.
 *
 * Returns an `Unsubscribe`; call it to stop syncing (e.g. on teardown).
 *
 * TODO(#237-4b / ADR-65): roots-registry upgrade path — see ADR 65. If a
 * RootsHarness ever owns the unified view, this binding writes mount
 * deltas INTO it and the notify still fires off the registry's change
 * stream; the client-facing contract is unchanged.
 */
export function bindSandboxRootsToClient(
  sandbox: SandboxHarness,
  client: McpClientHarness,
): Unsubscribe {
  return sandbox.subscribeMounts(() => {
    void Promise.resolve(client.notifyRootsListChanged()).catch(() => {
      // Client not ready / connection dropped — the server re-pulls
      // `roots/list` on its own cadence; a missed notification is benign.
    });
  });
}
