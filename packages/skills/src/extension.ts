/**
 * `withSkills()` — `SessionExtension` factory.
 *
 * Constructs a {@link SkillsHarness} per-session at session install
 * time, wired to the session's substrate. Adopters who want a
 * custom backend (sqlite-backed, remote registry) pass a configured
 * `withSkills({ ... })`.
 *
 * **Wiring status.** SessionInstaller is the formal install surface
 * per ADR 26 Step 8. When SessionHarness drives session-targeted
 * extensions through it, this factory is the default `skills` slot.
 * Adopters override by passing a configured `withSkills({ ... })` in
 * `AppHarnessOptions.extensions`.
 *
 * @see docs/proposals/v2/blueprint/32-extension-shape-spectrum.md
 */

import type { SessionExtension, SessionInstaller, SkillsRegisterInput } from "@agentick/spec";
import { SkillsHarness } from "./harness.js";

export interface WithSkillsOptions {
  /**
   * Initial skill set seeded at session construction. Useful for
   * shipping bundled "starter" skills (e.g., framework-defined
   * recipes) or for restore-from-snapshot at startup.
   */
  readonly initial?: readonly SkillsRegisterInput[];
}

export function withSkills(options: WithSkillsOptions = {}): SessionExtension {
  return {
    name: "@agentick/skills",
    target: "session",
    install: async (installer: SessionInstaller) => {
      const harness = new SkillsHarness(
        `${installer.hostId}:skills`,
        installer.substrate.journal,
        installer.substrate.bus,
        installer.substrate.inbox,
      );
      await harness.ready;

      // Seed initial skills via the async surface so envelopes flow
      // through the journal — adopters subscribing to `skills:register`
      // see them on session boot.
      if (options.initial && options.initial.length > 0) {
        for (const skill of options.initial) {
          await harness.register(skill);
        }
      }

      installer.registerNamespace("skills", harness);
      installer.onClose(() => harness.close());
    },
  };
}
