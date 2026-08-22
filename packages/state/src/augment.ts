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
 * Loaded as a side effect when anything imports from `@agentick/state`.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import { registerNamespaceSlot } from "@agentick/runtime";
import { omitUndefined } from "@agentick/utils";
import type { StateHarnessProtocol } from "@agentick/spec";
import type { StateHandle } from "./handle.js";
import { createStateStore, type StateDefinition } from "./store.js";

declare module "@agentick/spec" {
  interface HookBridges {
    readonly state: StateHarnessProtocol;
  }

  /**
   * ADR 93 — the top-level `state` config slot: `createApp({ state: { store } })`.
   * State is HOST-CONSTRUCTED (the session builds the harness for its required
   * bridge set), so the slot names the definition only.
   */
  interface NamespaceSlots {
    readonly state?: StateDefinition;
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

// ADR 93 — the RUNTIME half of the slot registration. The `appScope` arm
// (checkpointing §4) is ONE default value store per APP: cells are partitioned
// by harness scope, so every session shares it without colliding, and an
// evicted session's values are still there when it is rebuilt. An adopter store
// (`createApp({ state: { store: pgStateStore } })`) wins.
registerNamespaceSlot("state", {
  appScope: () => {
    const store = createStateStore();
    return (value) => ({ store, ...omitUndefined((value ?? {}) as object) });
  },
});
