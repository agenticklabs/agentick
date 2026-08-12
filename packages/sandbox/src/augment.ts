/**
 * Module augmentation — adds `bridges.sandbox` to `HookBridges`,
 * `sandbox` to `NamespaceSlots`, `ctx.sandbox` to
 * `ToolHandlerCtxExtensions`, AND `sandboxId` to `EventScopeExtensions`
 * — plus the runtime `registerNamespaceSlot("sandbox", …)` that lets
 * `createApp({ sandbox })` forward without importing this package.
 *
 * Adopters who import anything from `@agentick/sandbox` (or
 * `@agentick/sandbox/react`) bring the augmentations in, and
 * `createApp({ sandbox })` + `useBridges().sandbox` + `ctx.sandbox` +
 * `eventScope.sandboxId` are typed correctly. Adopters who don't, never
 * see the slot.
 *
 * `ctx.sandbox` (ADR 66) carries the SAME `SandboxBridge` as
 * `bridges.sandbox` — the session-scoped registry, dispatch-resolved from
 * the live bridge rather than captured at render through the JSX `use:`
 * bag. A tool handler resolves the active `SandboxHarness` from it
 * (`ctx.sandbox.get("primary")`); see `react/tools.tsx`. `useSandbox()`
 * (the React hook) remains for component/render use — it reads the
 * tree-nearest harness from Context.
 *
 * @see docs/proposals/v2/blueprint/66-tool-dependency-resolution.md
 *      (the `ctx.sandbox` seam)
 * @see docs/proposals/v2/blueprint/45-runtime-context-model.md (the
 *      EventScope augmentation pattern this file follows)
 */

import { registerNamespaceSlot } from "@agentick/runtime";

import type { SandboxBridge } from "./bridge.js";
import type { SandboxDefinition } from "./definition.js";
import { withSandbox } from "./extension.js";

declare module "@agentick/spec" {
  interface HookBridges {
    readonly sandbox?: SandboxBridge;
  }

  /**
   * ADR 93 — the top-level `sandbox` config slot:
   * `createApp({ sandbox: defineSandbox({ provider }) })`. Present iff an
   * adopter imports a sandbox package; sandbox stays an OPTIONAL install (a
   * slot is not the same as being bundled into the metapackage).
   */
  interface NamespaceSlots {
    readonly sandbox?: SandboxDefinition;
  }

  interface ToolHandlerCtxExtensions {
    /**
     * The session-scoped `SandboxBridge` (ADR 66). Present iff `withSandbox()`
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

// ADR 93 — the RUNTIME half of the slot registration: `sandbox` is a
// namespace-config key the app forwards, minted through this package's own
// `withSandbox`, without the app importing this package.
registerNamespaceSlot("sandbox", {
  toExtension: (value) => withSandbox(value as SandboxDefinition),
});
