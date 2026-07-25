/**
 * Module augmentation — adds `bridges.sandbox` to `HookBridges`,
 * `ctx.sandbox` to `ToolHandlerCtxExtensions`, AND `sandboxId` to
 * `EventScopeExtensions`.
 *
 * Adopters who import anything from `@agentick/sandbox` (or
 * `@agentick/sandbox/react`) bring all three augmentations in, and
 * `useBridges().sandbox` + `ctx.sandbox` + `eventScope.sandboxId` are
 * typed correctly. Adopters who don't, never see the slot.
 *
 * `ctx.sandbox` (ADR 66) carries the SAME `SandboxBridge` as
 * `bridges.sandbox` — the app-scoped registry, dispatch-resolved from
 * the live bridge rather than captured at render through the JSX `use:`
 * bag. A tool handler resolves the active `SandboxHarness` from it
 * (`ctx.sandbox.get("primary")`); see `react/tools.tsx`. `useSandbox()`
 * (the React hook) remains for component/render use — it reads the
 * tree-nearest harness from Context.
 *
 * Side-effect-only file: imported for its `declare module` block.
 *
 * @see docs/proposals/v2/blueprint/66-tool-dependency-resolution.md
 *      (the `ctx.sandbox` seam)
 * @see docs/proposals/v2/blueprint/45-runtime-context-model.md (the
 *      EventScope augmentation pattern this file follows)
 */

import type { SandboxBridge } from "./bridge.js";

declare module "@agentick/spec" {
  interface HookBridges {
    readonly sandbox?: SandboxBridge;
  }

  interface ToolHandlerCtxExtensions {
    /**
     * The app-scoped `SandboxBridge` (ADR 66). Present iff `withSandbox()`
     * is installed; `undefined` otherwise, so handlers MUST guard
     * (`ctx.sandbox?`). Resolve the active harness from it — the built-in
     * tools use `ctx.sandbox.get("primary")` (the default `<Sandbox>` id).
     * Same value as `useBridges().sandbox`, resolved at dispatch from the
     * live bridge rather than captured at render.
     */
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
