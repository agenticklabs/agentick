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
import { isTimelineHarnessInstance } from "./definition.js";
import { MemoryTimelineStore } from "./store.js";

// ADR 51 slice 5 (#141) — the wire projection of the ratified VERB-MATRIX rows
// (`timeline/history`, `timeline/compact`, `timeline/commands`). They live in
// their own file so the CLIENT subpath can type them without loading these
// server-bridge augmentations.
import "./wire-augment.js";

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

// ADR 93 — the RUNTIME half of the slot registration (the `NamespaceSlots`
// augmentation above is the type half). Tells the app that `timeline` is a
// namespace-config key it should forward, without the app importing this
// package. A side effect on import, exactly like the `HookBridges` slot: the
// metapackage bundles this package, so the slot is always lit for built-ins;
// an optional package's slot lights up on install + import.
// The `appScope` arm (checkpointing §4) — ONE default log store per APP, shared
// by every session it creates. Entries are partitioned by log key, so sharing is
// safe; the lifetime is the point: a per-harness default store leaves an evicted
// session with nothing to hydrate from. An adopter store, and a live harness,
// both win outright.
registerNamespaceSlot("timeline", {
  appScope: () => {
    const store = new MemoryTimelineStore();
    return (value) =>
      isTimelineHarnessInstance(value) ? value : { store, ...(value as object | undefined) };
  },
});
