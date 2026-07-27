import type { CommandInfo } from "@agentick/spec";
/**
 * Module augmentation — adds the timeline slot to two spec interfaces:
 *
 *   1. `HookBridges.timeline`        → the full harness protocol, for
 *                                       internal bridge plumbing.
 *   2. `SessionHarnessProtocol.timeline` → the curated user-facing
 *                                          handle, exposed at the top
 *                                          of every session.
 *
 * Per ADR 27 (modular built-ins): foundational and optional harness
 * packages register their slot via TypeScript module augmentation.
 * `@agentick/spec` ships empty seeds for both `HookBridges` and the
 * top-level session slots; each harness adds its own slot here.
 *
 * Loaded as a side effect when anything imports from `@agentick/timeline`.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import { registerNamespaceSlot } from "@agentick/runtime";
import type { TimelineHarnessProtocol } from "@agentick/spec";
import type { TimelineHandle } from "./handle.js";
import type { TimelineConfig } from "./extension.js";

declare module "@agentick/spec" {
  interface HookBridges {
    readonly timeline: TimelineHarnessProtocol;
  }

  /**
   * ADR 93 — the top-level `timeline` config slot: `createApp({ timeline })`.
   * Accepts the ADR-42 dichotomy, no third form: a `defineTimeline(...)`
   * DEFINITION (or the identical inline bag) or a LIVE harness instance.
   *
   * Registered here, not in `@agentick/app` — the app package names no
   * namespace (ADR 27: built-ins are bundled, never privileged). The runtime
   * half is the `registerNamespaceSlot("timeline")` side effect below.
   */
  interface NamespaceSlots {
    readonly timeline?: TimelineConfig;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface SessionHarnessProtocol<P> {
    /**
     * The session's timeline — append, queue, drain, compact, subscribe.
     * Curated subset of `TimelineHarnessProtocol`; the SessionHarness
     * owns lifecycle (`close`, `id`, `ready`) and snapshot import/export.
     */
    readonly timeline: TimelineHandle;
  }
}

// ADR 51 slice 5 (#141) — wire projection of the ratified VERB-MATRIX
// rows. Types derive from the same declarations the command registry
// validates at dispatch; `sessionId` addresses the dynamic lane.
declare module "@agentick/spec" {
  interface WireMethods {
    /** The flagship signal form: bare verb + optional advisory instructions. */
    "timeline/compact": {
      params: { sessionId: string; instructions?: string };
      result: unknown;
    };
    "timeline/commands": {
      params: { sessionId: string };
      result: { commands: readonly CommandInfo[] };
    };
  }
}

// ADR 93 — the RUNTIME half of the slot registration (the `NamespaceSlots`
// augmentation above is the type half). Tells the app that `timeline` is a
// namespace-config key it should forward, without the app importing this
// package. A side effect on import, exactly like the `HookBridges` slot: the
// metapackage bundles this package, so the slot is always lit for built-ins;
// an optional package's slot lights up on install + import.
registerNamespaceSlot("timeline");
