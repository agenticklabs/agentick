import type { CommandInfo } from "@agentick/spec-next";
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

// ADR 51 slice 5 (#141) — wire projection of the ratified VERB-MATRIX
// rows. Types derive from the same declarations the command registry
// validates at dispatch; `sessionId` addresses the dynamic lane.
declare module "@agentick/spec-next" {
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
