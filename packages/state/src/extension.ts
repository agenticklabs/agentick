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
import { stateScope, type StateStore } from "./store.js";

export interface WithStateOptions {
  /** Initial entries seeded at construction. */
  readonly initial?: Readonly<Record<string, unknown>>;
  /**
   * Durable backing for state VALUES (data-layer plan §3.5, Phase 3). Passed
   * through to the {@link StateHarness}; when omitted the harness defaults to a
   * fresh in-memory store. Inject a durable adapter to make state survive
   * restart — one store serves every session, partitioned by the harness scope
   * each cell carries, and the session's `restore()` fan-out hydrates from it.
   */
  readonly store?: StateStore;
}

// TODO(tools-sweep / three-audiences-plan §D): a `src/tools.ts` shipping
// model-facing `state_*` tools (e.g. `state_get` / `state_set`) would slot
// in here behind a `registerModelTools` option, same shape as
// `resources/src/tools.ts` + `skills/src/tools.ts`. DEFERRED: model-visible
// session state overlaps knobs (`knob_set`) — whether state gets its own
// model surface, and how it relates to knobs, is a policy question, so the
// convention does not launch it as filler. When added: reach the harness
// through a `ctx.state` slot (NOT `ctx.session`) + augment
// `ToolHandlerCtxExtensions`.
export function withState(options: WithStateOptions = {}): SessionExtension {
  return {
    name: "@agentick/state",
    target: "session",
    install: async (installer: SessionInstaller) => {
      const harness = new StateHarness(
        stateScope(installer.hostId),
        installer.substrate.journal,
        installer.substrate.bus,
        installer.substrate.inbox,
        options.store !== undefined ? { store: options.store } : {},
      );
      await harness.ready;

      if (options.initial && Object.keys(options.initial).length > 0) {
        harness.seed(options.initial);
      }

      installer.registerNamespace("state", harness);
      installer.onClose(() => harness.close());
    },
  };
}
