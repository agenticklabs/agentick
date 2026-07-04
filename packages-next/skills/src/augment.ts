import type { CommandInfo } from "@agentick/spec-next";
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
 * Loaded as a side effect when anything imports from `@agentick/skills-next`.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 * @see docs/proposals/v2/blueprint/32-extension-shape-spectrum.md
 */

import type { Skills } from "@agentick/spec-next";
import type { SkillsHandle } from "./handle.js";

declare module "@agentick/spec-next" {
  interface HookBridges {
    readonly skills: Skills;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface SessionHarnessProtocol<P> {
    /**
     * The session's skills library — register, search, retrieve.
     * Curated subset of `SkillsHarnessProtocol`; the SessionHarness
     * owns lifecycle and JSX-driven registration if/when a `<Skill>`
     * component lands.
     */
    readonly skills: SkillsHandle;
  }
}

// ADR 51 slice 5 (#141) — skill-library management from an admin UI is
// a designed surface; grants gate who.
declare module "@agentick/spec-next" {
  interface WireMethods {
    "skills/register": { params: { sessionId: string; [key: string]: unknown }; result: unknown };
    "skills/update": { params: { sessionId: string; [key: string]: unknown }; result: unknown };
    "skills/remove": { params: { sessionId: string; id: string }; result: unknown };
    "skills/commands": {
      params: { sessionId: string };
      result: { commands: readonly CommandInfo[] };
    };
  }
}
