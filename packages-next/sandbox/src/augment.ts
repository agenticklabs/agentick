/**
 * Module augmentation — adds `bridges.sandbox` to `HookBridges` AND
 * `sandboxId` to `EventScopeExtensions`.
 *
 * Adopters who import anything from `@agentick/sandbox-next` (or
 * `@agentick/sandbox-next/react`) bring both augmentations in, and
 * `useBridges().sandbox` + `eventScope.sandboxId` are typed correctly.
 * Adopters who don't, never see the slot.
 *
 * Side-effect-only file: imported for its `declare module` block.
 *
 * @see docs/proposals/v2/blueprint/45-runtime-context-model.md (the
 *      EventScope augmentation pattern this file follows)
 */

import type { SandboxBridge } from "./bridge.js";

declare module "@agentick/spec-next" {
  interface HookBridges {
    readonly sandbox?: SandboxBridge;
  }

  interface EventScopeExtensions {
    /**
     * Sandbox runtime identifier. Populated by sandbox harness
     * operations so subscribers can filter events to a specific
     * sandbox via `app.events({ scope: { sandboxId: "X" } })`.
     */
    readonly sandboxId?: string;
  }
}
