/**
 * Module augmentation — adds `bridges.timeline` to `HookBridges`.
 *
 * Per ADR 27 (modular built-ins): foundational and optional harness
 * packages register their `HookBridges` slot via TypeScript module
 * augmentation. `@agentick/spec` ships an empty `HookBridges` seed; each
 * harness adds its own slot here.
 *
 * Loaded as a side effect when anything imports from `@agentick/timeline`.
 * Adopters who use timeline (via the agentick metapackage or directly)
 * see `useBridges().timeline` typed correctly; adopters who don't, never
 * see the slot.
 *
 * Side-effect-only file: imported for its `declare module` block.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import type { TimelineHarnessProtocol } from "@agentick/spec";

declare module "@agentick/spec" {
  interface HookBridges {
    readonly timeline: TimelineHarnessProtocol;
  }
}
