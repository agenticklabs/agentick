/**
 * `withState()` — `SessionExtension` factory for the StateHarness.
 *
 * Constructs a `StateHarness` per-session at session install time,
 * wired to the session's substrate. The session's required-set
 * contract guarantees this slot exists; adopters who want a custom
 * implementation (e.g., redis-backed) pass their own
 * `withState({ ... })`.
 *
 * **Wiring status (ADR 26 Step 8 — pending).** SessionInstaller exists
 * in the spec; SessionHarness doesn't drive session-targeted extensions
 * through it yet. Today the SessionHarness constructs StateHarness
 * directly in `session-bridges.ts`. When Step 8 lands, this factory is
 * the default session extension and adopters override by passing a
 * configured `withState({ ... })` in `AppHarnessOptions.extensions`.
 */

import type { SessionExtension, SessionInstaller } from "@agentick/spec";
import { StateHarness } from "./harness.js";

export interface WithStateOptions {
  /** Initial entries seeded at construction. */
  readonly initial?: Readonly<Record<string, unknown>>;
}

export function withState(options: WithStateOptions = {}): SessionExtension {
  return {
    name: "@agentick/state",
    target: "session",
    install: async (installer: SessionInstaller) => {
      const harness = new StateHarness(
        `${installer.hostId}:state`,
        installer.substrate.journal,
        installer.substrate.bus,
        installer.substrate.inbox,
      );
      await harness.ready;

      if (options.initial && Object.keys(options.initial).length > 0) {
        harness.importSnapshot(options.initial);
      }

      installer.registerNamespace("state", harness);
      installer.onClose(() => harness.close());
    },
  };
}
