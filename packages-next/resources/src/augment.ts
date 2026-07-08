/**
 * Module augmentation — adds the `resources` slot to TWO spec
 * interfaces (ADR 27: each harness package owns its own slot
 * declaration; the spec stays neutral):
 *
 *   1. `HookBridges.resources`            → React/render-time access
 *                                            (`<Resource>` / the
 *                                            `resources` default
 *                                            projection).
 *   2. `SessionHarnessProtocol.resources` → server-side / adopter
 *                                            access (`await
 *                                            session.resources.read(uri)`).
 *
 * **`HookBridges.resources` stays OPTIONAL** — the general bridges
 * contract admits stub/substrate-stripped mounts that don't wire one
 * (mirrors `bridges.prompts`), so consumers feature-detect. In
 * PRODUCTION the AppHarness constructs one per session at the single
 * site (#159), exactly like tasks, so it is always present there —
 * hence `SessionHarnessProtocol.resources` is REQUIRED.
 *
 * Loaded as a side effect when anything imports from
 * `@agentick/resources-next`.
 *
 * @see docs/proposals/v2/blueprint/62-resources-harness.md
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import type { Resources } from "@agentick/spec-next";

declare module "@agentick/spec-next" {
  interface HookBridges {
    /**
     * Application-controlled read-projection seam (ADR 62). A registry
     * of `URI → resolver` bindings the MCP server projects out over
     * `resources/*` and the `resources` default projection folds into a
     * catalog. Optional at the general-bridges layer (stub mounts);
     * always present on a production session.
     */
    readonly resources?: Resources;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface SessionHarnessProtocol<P> {
    /**
     * The session's resources surface — same instance the per-session
     * tool executor (`ctx.resource`), `bridges.resources`, and
     * `withMCP` remote-resource surfacing all use. Adopter / server-side
     * code reads content without a tool ctx: `session.resources.read(uri)`.
     */
    readonly resources: Resources;
  }
}
