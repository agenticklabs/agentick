/**
 * `withCompletions()` — the install form for the CompletionsHarness.
 *
 * Two ways to configure a session's completion sources, one type:
 *
 *   - `createApp({ completions: defineCompletions({...}) })` — the top-level
 *     SLOT (ADR 93), lit by this package's `augment.ts`. The normal path.
 *   - `extensions: [withCompletions({...})]` — the fully-dynamic escape hatch
 *     (runtime-built maps, conditional composition). An explicit entry here
 *     OVERRIDES the slot: extensions run after the slot-minted install and
 *     namespace registration is last-writer-wins.
 *
 * Both take the same {@link CompletionsConfig} — the ADR-42 dichotomy: a
 * definition (`{ sources }`), or a live `Completions` instance whose lifecycle
 * the adopter owns (so it is NOT closed on session close).
 *
 * @see ./augment.ts — the top-level slot registration
 * @see docs/proposals/v2/blueprint/93-namespace-definitions.md
 */

import {
  isCompletionsInstance,
  type SessionExtension,
  type SessionInstaller,
} from "@agentick/spec";

import { CompletionsHarness } from "./harness.js";
import { sourcesMapOf, type CompletionsConfig, type CompletionsDefinition } from "./definition.js";

/**
 * Options `withCompletions` accepts. An alias of {@link CompletionsDefinition} —
 * kept as a name because `withX` options types are part of the adopter
 * vocabulary, but structurally identical: there is one shape, not a parallel one.
 */
export type WithCompletionsOptions = CompletionsDefinition;

export function withCompletions(config: CompletionsConfig = {}): SessionExtension {
  return {
    name: "@agentick/completions",
    target: "session",
    install: async (installer: SessionInstaller) => {
      // ── Live-instance arm: register and get out of the way. The adopter owns
      // construction and teardown — we do not close what we did not open.
      if (isCompletionsInstance(config)) {
        installer.registerNamespace("completions", config);
        return;
      }

      // ── Definition arm: construct THIS session's harness and bind the sources.
      //
      // NO `inheritedFrom(installer)`. That cascade exists to make an app-level
      // `use` / `guard` / `hook` reach a namespace's OPERATIONS — and this
      // harness deliberately declares none: `resolve` is a plain door precisely
      // so a keystroke does not mint a journaled op (completions.md §5). Wiring
      // the cascade here would inherit interceptors that can never fire, which
      // reads as coverage the harness does not have.
      //
      // TODO(completions-p2): the `complete` wire verb must NOT become a declared
      // command for the same reason — journal pollution per keystroke. Route it
      // as a gateway method that calls `resolve()` directly. If that decision is
      // ever reversed, `inheritedFrom(installer)` belongs on the constructor call
      // below (ADR 93 landmine 11 — the cascade must be TOTAL).
      const harness = new CompletionsHarness(
        `${installer.hostId}:completions`,
        installer.substrate.journal,
        installer.substrate.bus,
        installer.substrate.inbox,
        { parentScope: { sessionId: installer.sessionId } },
      );
      await harness.ready;

      for (const [name, resolver] of Object.entries(sourcesMapOf(config.sources ?? {}))) {
        harness.register(name, resolver);
      }

      installer.registerNamespace("completions", harness);
      installer.onClose(() => harness.close());
    },
  };
}
