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
 * Loaded as a side effect when anything imports from `@agentick/knobs-next`.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import type { KnobsHarnessProtocol } from "@agentick/spec-next";
import type { KnobsHandle } from "./handle.js";

// The `WireMethods` rows (knobs/set, knobs/commands) live in their own file so
// the client subpath can load them without the server-bridge augmentations.
import "./wire-augment.js";

declare module "@agentick/spec-next" {
  interface HookBridges {
    readonly knobs: KnobsHarnessProtocol;
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
