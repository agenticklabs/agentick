/**
 * `withElicitation()` — `SessionExtension` factory (no-op as of #159).
 *
 * The AppHarness constructs the per-session {@link ElicitationHarness}
 * BEFORE session-extension installs run (single-construction-site,
 * #159) and exposes it on `installer.elicitation`. `withElicitation()`
 * therefore does NOT construct a harness; constructing one against
 * the same substrate would collide on the inbox address
 * (`elicitation:${sessionId}:elicitation`) and cause
 * `bridges.elicitation` / `ctx.elicitation` / `session.elicitation` to
 * resolve to different instances.
 *
 * Why does the factory still exist? Two reasons.
 *
 *   1. Adopter symmetry — `withTasks()` survives to register
 *      model-facing tools; keeping `withElicitation()` as a documented
 *      no-op preserves the `extensions: [...]` mental model ("opt
 *      into the substrate primitives explicitly").
 *   2. Future configuration hooks — when a per-session config seam
 *      lands (e.g., `defaultTimeoutMs`, `onElicit` middleware), this
 *      is the documented surface.
 *
 * Open question (#159): the `defaultTimeoutMs` option was removed —
 * the host owns construction now. Reinstating it requires a new
 * config seam at AppHarness construction time
 * (`createApp({ elicitation: { defaultTimeoutMs } })`). Tracked
 * separately.
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 */

import type { SessionExtension } from "@agentick/spec";

export function withElicitation(): SessionExtension {
  return {
    name: "@agentick/elicitation",
    target: "session",
    install: (): void => {
      // No-op. The host (AppHarness) is the single construction
      // site for `ElicitationHarness` per #159. See file docblock.
    },
  };
}
