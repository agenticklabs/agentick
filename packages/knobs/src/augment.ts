/**
 * Module augmentation — adds the knobs slot to two spec interfaces:
 *
 *   1. `HookBridges.knobs`              → full `KnobsHarnessProtocol`,
 *                                          for internal bridge plumbing.
 *   2. `SessionHarnessProtocol.knobs`   → curated user-facing handle,
 *                                          exposed at the top of every
 *                                          session.
 *
 * Per ADR 27 (modular built-ins): each harness package augments the
 * spec's empty seeds with its own slot.
 *
 * Loaded as a side effect when anything imports from `@agentick/knobs`.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import { registerNamespaceSlot } from "@agentick/runtime";
import { omitUndefined } from "@agentick/utils";
import type { KnobsHarnessProtocol } from "@agentick/spec";
import type { KnobsHandle } from "./handle.js";
import { createKnobStore, type KnobsDefinition } from "./store.js";

// The `WireMethods` rows (knobs/set, knobs/commands) live in their own file so
// the client subpath can load them without the server-bridge augmentations.
import "./wire-augment.js";

declare module "@agentick/spec" {
  interface HookBridges {
    readonly knobs: KnobsHarnessProtocol;
  }

  /**
   * ADR 93 — the top-level `knobs` config slot: `createApp({ knobs: { store } })`.
   * Knobs is HOST-CONSTRUCTED (the session builds the harness for its required
   * bridge set), so the slot names the definition only; there is no live-instance
   * arm to discriminate.
   */
  interface NamespaceSlots {
    readonly knobs?: KnobsDefinition;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface SessionHarnessProtocol<P> {
    /**
     * The session's knobs — list, get, set, dispatch, subscribe.
     * Curated subset of `KnobsHarnessProtocol`; the SessionHarness
     * owns lifecycle and JSX-driven registration.
     *
     * For per-knob handles, use `session.knob(name)`.
     */
    readonly knobs: KnobsHandle;
  }
}

// ADR 93 — the RUNTIME half of the slot registration. The `appScope` arm
// (checkpointing §4) is ONE default value store per APP: cells are partitioned
// by harness scope, so every session shares it without colliding, and an
// evicted session's values are still there when it is rebuilt. An adopter store
// (`createApp({ knobs: { store: pgKnobStore } })`) wins.
registerNamespaceSlot("knobs", {
  appScope: () => {
    const store = createKnobStore();
    return (value) => ({ store, ...omitUndefined((value ?? {}) as object) });
  },
});
