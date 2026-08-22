/**
 * `withTimeline()` — the DYNAMIC install form for the TimelineHarness.
 *
 * Two ways to configure a session's timeline, one type:
 *
 *   - `createApp({ timeline: defineTimeline({...}) })` — the top-level SLOT
 *     (ADR 93), lit by this package's `augment.ts`. The normal path: the
 *     definition flows down to the ONE harness the session constructs for its
 *     required bridge set.
 *   - `extensions: [withTimeline({...})]` — the fully-dynamic escape hatch
 *     (runtime-built arrays, conditional composition). Installs a harness and
 *     registers it as the session's `timeline` namespace, OVERRIDING the
 *     session's own. Prefer the slot unless you need the dynamism.
 *
 * Both take the SAME {@link TimelineDefinition} — "the definition IS the
 * options" (ADR 93 §Composition ruling). A live `TimelineHarnessProtocol` is
 * also accepted: the BYO / single-session escape hatch, whose lifecycle the
 * adopter owns (so it is NOT closed on session close, and genesis is NOT run —
 * an instance the adopter built is an instance the adopter has already prepared).
 *
 * @see docs/proposals/v2/blueprint/93-namespace-definitions.md
 * @see ./augment.ts — the top-level slot registration
 */

import type { SessionExtension, SessionInstaller, TimelineHarnessProtocol } from "@agentick/spec";
import { inheritedFrom } from "@agentick/runtime";
import { TimelineHarness } from "./harness.js";
import { isTimelineHarnessInstance, type TimelineDefinition } from "./definition.js";
import { timelineScopeKey } from "./store.js";

/**
 * What `withTimeline` / the `timeline` slot accept — the ADR-42 dichotomy, no
 * third form: a DEFINITION (declarative, inert until install, constructed
 * per-session) or a LIVE INSTANCE (the adopter owns its lifecycle).
 */
export type TimelineConfig = TimelineDefinition | TimelineHarnessProtocol;

/**
 * Options `withTimeline` accepts. An alias of {@link TimelineDefinition} — kept
 * as a name because `withX` options types are part of the adopter vocabulary,
 * but structurally identical: there is one shape, not a parallel one.
 *
 * `initial` is GONE (ADR 93): seeding is genesis. `withTimeline({ initial:
 * entries })` becomes `withTimeline({ hydrate: async () => entries })` — the
 * same effect, through the one seam, and now composable with a store, a
 * principal, and the journal.
 */
export type WithTimelineOptions = TimelineDefinition;

// TODO(tools-sweep / three-audiences-plan §D): a `src/tools.ts` shipping
// model-facing `timeline_*` tools (e.g. `timeline_compact`) would slot in
// here behind a `registerModelTools` option, same shape as
// `resources/src/tools.ts` + `skills/src/tools.ts`. DEFERRED: a
// model-invocable `compact` is a policy question (the guard/attestation
// story must be told first), so the convention does not launch it as
// filler. When added: register via `installer.registerToolHandler` +
// `registerExtensionTool`, reach the harness through a `ctx.timeline` slot
// (NOT `ctx.session`), and add the `ToolHandlerCtxExtensions` augmentation.
export function withTimeline(config: TimelineConfig = {}): SessionExtension {
  return {
    name: "@agentick/timeline",
    target: "session",
    install: async (installer: SessionInstaller) => {
      // ── Live-instance arm: register and get out of the way. The adopter owns
      // construction, genesis, and teardown — we do not close what we did not
      // open, and we do not re-run genesis on an already-prepared instance.
      if (isTimelineHarnessInstance(config)) {
        installer.registerNamespace("timeline", config);
        return;
      }

      // ── Definition arm: construct THIS session's harness from the plan.
      const harness = new TimelineHarness(
        timelineScopeKey(installer.hostId),
        installer.substrate.journal,
        installer.substrate.bus,
        installer.substrate.inbox,
        {
          ...config,
          // ADR 93 landmine 11 — the cascade must be TOTAL. An extension-installed
          // namespace inherits the app/session interceptor cascade through the
          // installer's handle, exactly like a session-constructed bridge does;
          // without this an app `guard`/`hook` silently skips it.
          ...inheritedFrom(installer),
          // …and so must the emitted scope. An extension-installed timeline is a
          // SESSION's timeline as much as a bridge-constructed one, so it stamps
          // the host session on its envelopes — otherwise this arm reintroduces
          // the dead client live tail that `parentScope` exists to fix.
          parentScope: { sessionId: installer.hostId },
        },
      );
      await harness.ready;
      // GENESIS (ADR 93) — before the harness is visible to any renderer.
      // `hydrate()` is a no-op when the definition configures neither a store
      // nor a hydrator, so the store-less default path stays zero-cost.
      await harness.hydrate();

      installer.registerNamespace("timeline", harness);
      installer.onClose(() => harness.close());
    },
  };
}
