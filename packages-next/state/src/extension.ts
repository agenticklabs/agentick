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

import type { CollectionStore, SessionExtension, SessionInstaller } from "@agentick/spec-next";
import { StateHarness } from "./harness.js";
import type { StateEntry, StateStoreQuery } from "./store.js";

export interface WithStateOptions {
  /** Initial entries seeded at construction. */
  readonly initial?: Readonly<Record<string, unknown>>;
  /**
   * Durable backing for state VALUES (data-layer plan §3.5, Phase 3). Passed
   * through to the {@link StateHarness}; when omitted the harness defaults to a
   * fresh in-memory store. Inject a durable adapter to make state survive
   * restart. NOTE: session-level hydrate-on-resume is NOT wired here — that is
   * the Phase-4 manifest concern; `importSnapshot` remains the resume path.
   */
  readonly store?: CollectionStore<StateEntry, StateStoreQuery>;
}

export function withState(options: WithStateOptions = {}): SessionExtension {
  return {
    name: "@agentick/state-next",
    target: "session",
    install: async (installer: SessionInstaller) => {
      const harness = new StateHarness(
        `${installer.hostId}:state`,
        installer.substrate.journal,
        installer.substrate.bus,
        installer.substrate.inbox,
        options.store !== undefined ? { store: options.store } : {},
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
