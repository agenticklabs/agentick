/**
 * Module augmentation — adds `bridges.knobs` to `HookBridges`.
 *
 * Per ADR 27 (modular built-ins): foundational and optional harness
 * packages register their `HookBridges` slot via TypeScript module
 * augmentation. `@agentick/spec` ships an empty `HookBridges` seed; each
 * harness adds its own slot here.
 *
 * Loaded as a side effect when anything imports from `@agentick/knobs`.
 *
 * Side-effect-only file: imported for its `declare module` block.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import type { KnobsHarnessProtocol } from "@agentick/spec";

declare module "@agentick/spec" {
  interface HookBridges {
    readonly knobs: KnobsHarnessProtocol;
  }
}
