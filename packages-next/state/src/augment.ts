/**
 * Module augmentation — adds the state slot to two spec interfaces:
 *
 *   1. `HookBridges.state`              → full `StateHarnessProtocol`,
 *                                          for internal bridge plumbing.
 *   2. `SessionHarnessProtocol.state`   → curated user-facing handle,
 *                                          exposed at the top of every
 *                                          session.
 *
 * Per ADR 27 (modular built-ins): each harness package augments the
 * spec's empty seeds with its own slot.
 *
 * Loaded as a side effect when anything imports from `@agentick/state-next`.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import type { StateHarnessProtocol } from "@agentick/spec-next";
import type { StateHandle } from "./handle.js";

declare module "@agentick/spec-next" {
  interface HookBridges {
    readonly state: StateHarnessProtocol;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface SessionHarnessProtocol<P> {
    /**
     * The session's adopter-stash state — get/set/has/delete/list,
     * plus per-key and global subscription. Not model-visible.
     */
    readonly state: StateHandle;
  }
}
