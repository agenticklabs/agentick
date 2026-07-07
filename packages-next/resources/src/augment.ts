/**
 * Module augmentation — adds the `resources` slot to the spec's
 * `HookBridges` seed (ADR 27: each harness package owns its own slot
 * declaration; the spec stays neutral).
 *
 * **Optional slot.** Resources is a bundled built-in but not a substrate
 * primitive — a session only has one when a compiler front-end (the
 * React `<Resource>` component / `ctx.resource()`, Wave 4b) or an
 * adopter registers bindings. Consumers must check before use; the
 * reconciler iterates `HookBridges` generically via feature detection,
 * so absence is a valid state (mirrors `bridges.prompts`).
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
     * `resources/*`. Present only when a resources front-end or adopter
     * wired one; check before use.
     */
    readonly resources?: Resources;
  }
}
