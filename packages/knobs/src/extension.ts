/**
 * `withKnobs()` — `SessionExtension` factory.
 *
 * Constructs a {@link KnobsHarness} per-session at session install
 * time, wired to the session's substrate. The session's required-set
 * contract guarantees this slot exists; adopters who want a custom
 * implementation pass a configured `withKnobs({ ... })`.
 *
 * **Wiring status (ADR 26 Step 8 — pending).** SessionInstaller exists
 * in the spec; SessionHarness doesn't drive session-targeted extensions
 * through it yet. Today the SessionHarness constructs KnobsHarness
 * directly in `session-bridges.ts`. When Step 8 lands, this factory is
 * the default session extension and adopters override by passing a
 * configured `withKnobs({ ... })` in `AppHarnessOptions.extensions`.
 *
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 */

import type { CollectionMutation, Store, SessionExtension, SessionInstaller } from "@agentick/spec";
import { KnobsHarness } from "./harness.js";
import { knobsScope, type KnobEntry, type KnobStoreQuery } from "./store.js";

export interface WithKnobsOptions {
  /**
   * Initial knob values seeded at construction. Useful for tests +
   * snapshot-restore on startup. Keys map to knob ids; values are the
   * stored primitives.
   */
  readonly initial?: Readonly<Record<string, string | number | boolean>>;
  /**
   * Durable backing for knob VALUES (data-layer plan §3.5, Phase 3). Passed
   * through to the {@link KnobsHarness}; when omitted the harness defaults to a
   * fresh in-memory store, which a rebuilt harness does not share — so knob
   * values survive an evict/resume cycle exactly when the store injected here
   * outlives the session. Cells are partitioned by harness scope, so ONE store
   * passed to one `withKnobs()` correctly backs every session it installs into.
   */
  readonly store?: Store<KnobEntry, KnobStoreQuery, CollectionMutation<KnobEntry>>;
}

// NOTE: `knobsWireExtension` (./wire.js) IS registered in production — via
// `builtinWireExtensions` in `@agentick/app`, which the gateway registers
// in its bundled tier (`gateway/src/harness.ts`). It rides that path, NOT this
// `withKnobs()` session extension: `withKnobs`'s installer constructs its OWN
// `KnobsHarness` (below), while `buildSessionBridges` ALSO constructs one
// unconditionally — so folding the wire through a `withKnobs()` bundle would
// double-construct. The wire-extension is a stateless router (resolves the live
// session's knobs bridge at dispatch), so it registers once at gateway
// construction independent of the per-session bridge construction.
// AUTHZ: `knobs/set` is NOT ungated — the wire dispatch choke point
// (`@agentick/transport` `server/dispatch.ts` `authorizeDispatch`) gates
// EVERY resolved method with its verb-derived scope (`knobs:set`) + the target
// session's structural `requiredScopes` ceiling, before the handler runs;
// `unconfiguredAuthorizer` is deny-by-default for authenticated principals. A
// declared `WireMethodAuth` on `knobsWireExtension` is currently INERT (the
// choke point uses the verb-derived scope, not `extension.auth`) — declaring one
// only matters once that declarative layer is wired into `authorizeDispatch`.
export function withKnobs(options: WithKnobsOptions = {}): SessionExtension {
  return {
    name: "@agentick/knobs",
    target: "session",
    install: async (installer: SessionInstaller) => {
      const harness = new KnobsHarness(
        knobsScope(installer.hostId),
        installer.substrate.journal,
        installer.substrate.bus,
        installer.substrate.inbox,
        undefined,
        options.store !== undefined ? { store: options.store } : {},
      );
      await harness.ready;

      if (options.initial && Object.keys(options.initial).length > 0) {
        harness.seed(options.initial);
      }

      installer.registerNamespace("knobs", harness);
      installer.onClose(() => harness.close());
    },
  };
}
