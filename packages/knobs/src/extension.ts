/**
 * `withKnobs()` — `SessionExtension` factory.
 *
 * Constructs a {@link KnobsHarness} per-session at session install
 * time, wired to the session's substrate. The session's required-set
 * contract guarantees this slot exists; adopters who want a custom
 * implementation pass a configured `withKnobs({ ... })`.
 *
 * Note: SessionInstaller is defined in ADR 26 Step 1 but not yet
 * wired into the SessionHarness (that's Step 8). For now this factory
 * compiles and runs against a SessionInstaller-shaped object, but is
 * not called from a real session until Step 8 lands.
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 */

import type { SessionExtension, SessionInstaller } from "@agentick/spec";
import { KnobsHarness } from "./harness.js";

export interface WithKnobsOptions {
  /**
   * Initial knob values seeded at construction. Useful for tests +
   * snapshot-restore on startup. Keys map to knob ids; values are the
   * stored primitives.
   */
  readonly initial?: Readonly<Record<string, string | number | boolean>>;
}

export function withKnobs(options: WithKnobsOptions = {}): SessionExtension {
  return {
    name: "@agentick/knobs",
    target: "session",
    install: async (installer: SessionInstaller) => {
      const harness = new KnobsHarness(
        `${installer.hostId}:knobs`,
        installer.substrate.journal,
        installer.substrate.bus,
        installer.substrate.inbox,
      );
      await harness.ready;

      // Seed initial values if supplied. Goes through `importSnapshot`
      // so subscribers fire and `listCache` invalidates correctly.
      if (options.initial && Object.keys(options.initial).length > 0) {
        harness.importSnapshot(options.initial);
      }

      installer.registerNamespace("knobs", harness);
      installer.onClose(() => harness.close());
    },
  };
}
