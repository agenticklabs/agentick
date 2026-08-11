/**
 * Module augmentation — the `code` slot on FOUR spec interfaces (ADR 27: each
 * harness package owns its own slot declaration; the spec stays neutral):
 *
 *   1. `HookBridges.code`              → render-time access.
 *   2. `NamespaceSlots.code`           → `createApp({ code })`.
 *   3. `SessionHarnessProtocol.code`   → `session.code.run({ source })`.
 *   4. `ToolHandlerCtxExtensions.code` → dispatch-resolved `ctx.code`, the door
 *                                        a code-mode tool reaches through.
 *
 * Every slot is OPTIONAL: `code` is bundled, not privileged, and a session
 * that never installs it must not pretend to have it. "Always present" is a
 * statement about what `withCode()` costs when no runtime is bound, not a
 * claim that every session in the world carries the harness.
 *
 * Loaded as a side effect when anything imports from `@agentick/code`.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 * @see docs/proposals/v2/code.md
 */

import { registerNamespaceSlot } from "@agentick/runtime";

import type { Code } from "./contract.js";
import type { CodeConfig } from "./definition.js";
import { withCode } from "./extension.js";

declare module "@agentick/spec" {
  interface HookBridges {
    /** Present only when `withCode` is installed — consumers must guard. */
    readonly code?: Code;
  }

  /**
   * ADR 93 — the top-level `code` config slot:
   * `createApp({ code: defineCode({ runtime }) })`. Accepts the ADR-42
   * dichotomy: a DEFINITION (`{ runtime }`, branded or the identical inline
   * bag) or a LIVE harness instance.
   */
  interface NamespaceSlots {
    readonly code?: CodeConfig;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface SessionHarnessProtocol<P> {
    /**
     * The session's code surface — open a context, or run one program with
     * `session.code.run({ source, bindings })`. Present iff `withCode()` is
     * installed; the dynamic `session.<name>` extension-bridge getter provides
     * it at runtime.
     */
    readonly code?: Code;
  }

  interface EventScopeExtensions {
    /**
     * The execution context a `code:execute` operation ran in. Stamped by the
     * harness onto every envelope the op publishes, so
     * `app.events({ scope: { codeContextId } })` follows ONE context's
     * executions out of a session that is multiplexing several — the axis
     * `sessionId` cannot express, because a session holds as many open
     * contexts as it opened.
     */
    readonly codeContextId?: string;
  }

  interface ToolHandlerCtxExtensions {
    /**
     * The session's code harness (ADR 66) — dispatch-resolved from the live
     * bridge, so a tool handler runs model-authored code through the same
     * journaled, guardable operation the rest of the framework sees:
     * `await ctx.code?.run({ source, bindings: { tools } })`. Optional, so
     * handlers guard.
     */
    readonly code?: Code;
  }
}

// ADR 93 — the RUNTIME half of the slot registration. Tells the app that
// `code` is a namespace-config key it should forward, without the app
// importing this package. Extension-installed, so it supplies `toExtension`.
registerNamespaceSlot("code", {
  toExtension: (value) => withCode(value as CodeConfig),
});
