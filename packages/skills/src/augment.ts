/**
 * Module augmentation — registers the skills slot on two spec
 * interfaces:
 *
 *   1. `HookBridges.skills`              → full `SkillsHarnessProtocol`,
 *                                           for internal bridge plumbing.
 *   2. `SessionHarnessProtocol.skills`   → curated user-facing handle,
 *                                           exposed at the top of every
 *                                           session.
 *
 * Per ADR 27 (modular built-ins): each harness package augments the
 * spec's empty seeds with its own slot.
 *
 * Loaded as a side effect when anything imports from `@agentick/skills`.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 * @see docs/proposals/v2/blueprint/32-extension-shape-spectrum.md
 */

import { registerNamespaceSlot } from "@agentick/runtime";
import type { Skills } from "@agentick/spec";
import type { SkillsHandle } from "./handle.js";
import type { SkillsConfig } from "./definition.js";
import { withSkills } from "./extension.js";

// The `skills/*` WireMethods rows live in the type-only `./wire-augment.ts`
// (split so the `/client` subpath can type the wire without loading this
// server augment). Re-imported here for its side effect so importing
// `@agentick/skills` still contributes the rows.
import "./wire-augment.js";

declare module "@agentick/spec" {
  interface HookBridges {
    /**
     * Present only when `withSkills` is installed (an OPTIONAL extension,
     * uniform with `live` / `prompts`) — consumers reading `bridges.skills`
     * must guard. The SessionHarness exposes it via the dynamic extension-
     * bridge getter at runtime; typing it optional keeps `SessionHarness`
     * (which provides it dynamically, not as a declared class member)
     * structurally assignable to `SessionHarnessProtocol`.
     */
    readonly skills?: Skills;
  }

  /**
   * ADR 93 — the top-level `skills` config slot: `createApp({ skills })`.
   * Accepts the ADR-42 dichotomy, no third form: a `defineSkills(...)`
   * DEFINITION (or the identical inline bag) or a LIVE harness instance.
   *
   * Registered here, not in `@agentick/app` — the app package names no namespace
   * (ADR 27: built-ins are bundled, never privileged). The runtime half is the
   * `registerNamespaceSlot("skills", { toExtension })` side effect below.
   */
  interface NamespaceSlots {
    readonly skills?: SkillsConfig;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface SessionHarnessProtocol<P> {
    /**
     * The session's skills library — register, search, retrieve, run.
     * Curated subset of `SkillsHarnessProtocol` ({@link SkillsHandle}).
     * Present only when `withSkills` is installed (optional extension); the
     * dynamic `session.<name>` extension-bridge getter provides it at
     * runtime. Optional for the same reason `live` / `prompts` are.
     */
    readonly skills?: SkillsHandle;
  }

  interface ToolHandlerCtxExtensions {
    /**
     * The session's skills harness (ADR 66) — the dispatch-resolved ctx
     * slot the `skill_list` / `skill_read` model tools read. Present iff
     * `withSkills()` is installed; `undefined` otherwise, so handlers MUST
     * guard (`ctx.skills?`). Carries the SAME instance as `bridges.skills`
     * — the AppHarness pulls it from the session's `skills` namespace and
     * threads it as an opaque `ctxExtensions` value at the tool-executor
     * construction site, resolved at dispatch rather than captured at
     * render. A curated projection of the session, never `ctx.session`
     * (three-audiences-plan §D).
     */
    readonly skills?: Skills;
  }
}

// ADR 93 — the RUNTIME half of the slot registration (the `NamespaceSlots`
// augmentation above is the type half). Tells the app that `skills` is a
// namespace-config key it should forward, without the app importing this package.
// A side effect on import, exactly like the `HookBridges` slot.
//
// Skills is EXTENSION-INSTALLED (there is no construction site until an extension
// runs), so unlike the host-constructed timeline it also supplies the
// `toExtension` arm: `withSkills` already takes the definition | inline |
// live-instance dichotomy, so the slot value passes straight through.
registerNamespaceSlot("skills", {
  toExtension: (value) => withSkills(value as SkillsConfig),
});
