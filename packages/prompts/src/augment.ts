/**
 * Module augmentation — registers prompts slots on spec interfaces.
 *
 *   1. `HookBridges.prompts`              → full `PromptsHarnessProtocol`
 *   2. `SessionHarnessProtocol.prompts`   → curated `PromptsHandle`
 *
 * Loaded as side effect when anything imports from
 * `@agentick/prompts` (per ADR 27).
 */

import { registerNamespaceSlot } from "@agentick/runtime";
import type { Prompts } from "@agentick/spec";
import type { PromptsHandle } from "./handle.js";
import type { PromptsConfig } from "./definition.js";
import { withPrompts } from "./extension.js";

// The `prompts/*` WireMethods rows live in the type-only `./wire-augment.ts`
// (split so the `/client` subpath can type the wire without loading this
// server augment). Re-imported here for its side effect so importing
// `@agentick/prompts` still contributes the rows.
import "./wire-augment.js";

declare module "@agentick/spec" {
  interface HookBridges {
    /**
     * Present when `withPrompts` is installed; consumers must check
     * before use. Optional per ADR 27 §"Built-ins are bundled, not
     * privileged" — the compiler iterates `HookBridges` generically
     * via feature detection, so absence is a valid state.
     */
    readonly prompts?: Prompts;
  }

  /**
   * ADR 93 — the top-level `prompts` config slot: `createApp({ prompts })`.
   * Accepts the ADR-42 dichotomy, no third form: a `definePrompts(...)`
   * DEFINITION (or the identical inline bag) or a LIVE harness instance.
   *
   * Registered here, not in `@agentick/app` — the app package names no namespace
   * (ADR 27: built-ins are bundled, never privileged). The runtime half is the
   * `registerNamespaceSlot("prompts", { toExtension })` side effect below.
   */
  interface NamespaceSlots {
    readonly prompts?: PromptsConfig;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface SessionHarnessProtocol<P> {
    /**
     * The session's prompts library — register, invoke, get. Present
     * only when `withPrompts` is installed on the session; consumers
     * must check before use. Optional per ADR 27 §"Built-ins are
     * bundled, not privileged".
     */
    readonly prompts?: PromptsHandle;
  }
}

// ADR 93 — the RUNTIME half of the slot registration (the `NamespaceSlots`
// augmentation above is the type half). Tells the app that `prompts` is a
// namespace-config key it should forward, without the app importing this package.
//
// Prompts is EXTENSION-INSTALLED, so it also supplies the `toExtension` arm:
// `withPrompts` already takes the definition | inline | live-instance dichotomy,
// so the slot value passes straight through.
registerNamespaceSlot("prompts", {
  toExtension: (value) => withPrompts(value as PromptsConfig),
});
