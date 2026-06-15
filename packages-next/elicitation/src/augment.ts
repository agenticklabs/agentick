/**
 * Module augmentation — adds the `elicitation` slot to
 * `HookBridges` from `@agentick/spec-next`.
 *
 * Per ADR 27 (modular built-ins): each harness package augments the
 * spec's empty seed with its own slot. The spec itself stays neutral.
 *
 * **Required slot.** Elicitation is a substrate primitive — every
 * session has one. Consumer code reading `bridges.elicitation.elicit(...)`
 * does NOT need a null-check; sessions that don't surface a user end
 * up with a no-op transport, not a missing harness.
 *
 * Loaded as a side effect when anything imports from
 * `@agentick/elicitation-next`.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import type { ElicitationHarnessProtocol } from "@agentick/spec-next";

declare module "@agentick/spec-next" {
  interface HookBridges {
    /**
     * Substrate-level "ask user X" primitive. Tool confirmation, MCP
     * `elicitation/create`, agent-side asks all flow through this one
     * harness so the wire envelope, correlation engine, and
     * timeout/abort semantics live in one place.
     */
    readonly elicitation: ElicitationHarnessProtocol;
  }
}
