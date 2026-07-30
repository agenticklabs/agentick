/**
 * Module augmentation — registers the completions slot on FOUR spec interfaces
 * (ADR 27: each harness package owns its own slot declaration; the spec stays
 * neutral):
 *
 *   1. `HookBridges.completions`            → render-time access.
 *   2. `NamespaceSlots.completions`         → `createApp({ completions })`.
 *   3. `SessionHarnessProtocol.completions` → adopter access
 *                                             (`session.completions.resolve(...)`).
 *   4. `ToolHandlerCtxExtensions.completions` → dispatch-resolved `ctx.completions`.
 *
 * Loaded as a side effect when anything imports from `@agentick/completions`.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 * @see docs/proposals/v2/completions.md
 */

import { registerNamespaceSlot } from "@agentick/runtime";
import type { Completions } from "@agentick/spec";
import type { CompletionsConfig } from "./definition.js";
import { withCompletions } from "./extension.js";

declare module "@agentick/spec" {
  interface HookBridges {
    /**
     * Present only when `withCompletions` is installed (an OPTIONAL extension,
     * uniform with `skills` / `prompts`) — consumers reading
     * `bridges.completions` must guard. The SessionHarness provides it through
     * the dynamic extension-bridge getter at runtime.
     */
    readonly completions?: Completions;
  }

  /**
   * ADR 93 — the top-level `completions` config slot:
   * `createApp({ completions: defineCompletions({...}) })`. Accepts the ADR-42
   * dichotomy: a DEFINITION (`{ sources }`, branded or the identical inline
   * bag) or a LIVE harness instance.
   *
   * Registered here, not in `@agentick/app` — the app package names no namespace
   * (ADR 27: built-ins are bundled, never privileged). The runtime half is the
   * `registerNamespaceSlot("completions", { toExtension })` side effect below.
   */
  interface NamespaceSlots {
    readonly completions?: CompletionsConfig;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface SessionHarnessProtocol<P> {
    /**
     * The session's completion sources — register a resolver, enumerate the
     * completable names, resolve one. Present only when `withCompletions` is
     * installed; the dynamic `session.<name>` extension-bridge getter provides it
     * at runtime, so it is optional for the same reason `skills` / `prompts` are.
     */
    readonly completions?: Completions;
  }

  interface ToolHandlerCtxExtensions {
    /**
     * The session's completions harness (ADR 66) — the dispatch-resolved ctx slot
     * a tool handler reads to resolve a named source itself
     * (`ctx.completions?.resolve("knowify.jobs", { value })`). Present iff
     * `withCompletions()` is installed, so handlers MUST guard.
     *
     * TODO(completions-p2): the AppHarness's `ctxExtensions` site
     * (`packages/app/src/harness.ts`, one line per tool-shipping harness) does
     * NOT yet pull the `completions` namespace, so this slot is typed but
     * `undefined` at runtime. Add
     * `sessionExtensionBridges.get("completions")` there alongside the `skills`
     * line when the wire verb lands and a handler has a reason to reach it.
     * Recorded in the README's known gaps rather than claimed as working.
     */
    readonly completions?: Completions;
  }
}

// ADR 93 — the RUNTIME half of the slot registration (the `NamespaceSlots`
// augmentation above is the type half). Tells the app that `completions` is a
// namespace-config key it should forward, without the app importing this package.
//
// Completions is EXTENSION-INSTALLED (there is no construction site until an
// extension runs), so it supplies the `toExtension` arm: `withCompletions`
// already accepts the definition-map | live-instance dichotomy, so the slot
// value passes straight through.
registerNamespaceSlot("completions", {
  toExtension: (value) => withCompletions(value as CompletionsConfig),
});
