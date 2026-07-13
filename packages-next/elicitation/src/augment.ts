/**
 * Module augmentation — adds the `elicitation` slot to TWO spec
 * interfaces:
 *
 *   1. `HookBridges.elicitation`            → React/render-time access
 *                                              for in-tree harnesses
 *                                              calling `elicit(...)`.
 *   2. `SessionHarnessProtocol.elicitation` → server-side access for
 *                                              the gateway routing
 *                                              `session/respond_to_elicitation`
 *                                              wire RPCs to
 *                                              `respond(...)`.
 *
 * Per ADR 27 (modular built-ins): each harness package augments the
 * spec's empty seed with its own slot. The spec itself stays neutral.
 *
 * **Required slots.** Elicitation is a substrate primitive — every
 * session has one. Consumer code reads through these slots without a
 * null check; sessions that don't surface a user end up with a no-op
 * transport, not a missing harness.
 *
 * Loaded as a side effect when anything imports from
 * `@agentick/elicitation-next`.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import type { Elicit, ElicitationHarnessProtocol } from "@agentick/spec-next";

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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface SessionHarnessProtocol<P> {
    /**
     * The session's elicitation harness — raw protocol surface. Same
     * instance the per-session tool executor + `bridges.elicitation`
     * use; clients reach it via `session/respond_to_elicitation` to
     * unblock pending elicitations. Prefer {@link elicit} for the
     * adopter-friendly sugar surface.
     */
    readonly elicitation: ElicitationHarnessProtocol;
    /**
     * Sugar surface — `Elicit` noun-aliased API over the session's
     * `elicitation` harness. Symmetric with `ctx.elicit` exposed to
     * tool handlers: same `Elicit` interface, same six form methods
     * + URL mode + try* variants + `requireUrls` deferred-auth
     * pattern.
     *
     * Built lazily by the session harness factory wiring; production
     * sessions always have it.
     */
    readonly elicit: Elicit;
  }
}
