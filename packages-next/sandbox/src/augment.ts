/**
 * Module augmentation — adds `bridges.sandbox` to `HookBridges`.
 *
 * Adopters who import anything from `@agentick/sandbox/v2` (or
 * `@agentick/sandbox/v2/react`) bring this augmentation in, and
 * `useBridges().sandbox` is typed correctly. Adopters who don't,
 * never see the slot.
 *
 * Side-effect-only file: imported for its `declare module` block.
 */

import type { SandboxBridge } from "./bridge.js";

declare module "@agentick/spec-next" {
  interface HookBridges {
    readonly sandbox?: SandboxBridge;
  }
}
