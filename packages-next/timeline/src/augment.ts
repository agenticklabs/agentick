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
 * `@agentick/spec-next` ships empty seeds for both `HookBridges` and the
 * top-level session slots; each harness adds its own slot here.
 *
 * Loaded as a side effect when anything imports from `@agentick/timeline-next`.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import type { TimelineHarnessProtocol } from "@agentick/spec-next";
import type { TimelineHandle } from "./handle.js";

declare module "@agentick/spec-next" {
  interface HookBridges {
    readonly timeline: TimelineHarnessProtocol;
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
