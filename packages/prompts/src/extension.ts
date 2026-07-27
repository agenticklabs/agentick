/**
 * `withPrompts()` — the DYNAMIC install form for the PromptsHarness.
 *
 * Two ways to configure a session's prompts, one type:
 *
 *   - `createApp({ prompts: definePrompts({...}) })` — the top-level SLOT
 *     (ADR 93), lit by this package's `augment.ts`. The normal path.
 *   - `extensions: [withPrompts({...})]` — the fully-dynamic escape hatch
 *     (runtime-built arrays, conditional composition). Installs the same
 *     harness; an explicit entry here OVERRIDES the slot, because extensions run
 *     after the slot-minted install and namespace registration is
 *     last-writer-wins.
 *
 * Both take the SAME {@link PromptsDefinition} — "the definition IS the options"
 * (ADR 93 §Composition ruling). A live `Prompts` instance is also accepted: the
 * BYO / single-session escape hatch, whose lifecycle the adopter owns (so it is
 * NOT closed on session close, and genesis is NOT run).
 *
 * For single-framework adopters, prefer the framework binding's convenience
 * extension (`withReactPrompts`), which pre-bakes the renderer.
 *
 * @see docs/proposals/v2/blueprint/93-namespace-definitions.md
 * @see ./augment.ts — the top-level slot registration
 */

import { isPromptsInstance, type SessionExtension, type SessionInstaller } from "@agentick/spec";
import { inheritedFrom } from "@agentick/runtime";

import { PromptsHarness } from "./harness.js";
import type { PromptsConfig, PromptsDefinition } from "./definition.js";
import { wirePromptProjection } from "./projection.js";

/**
 * Options `withPrompts` accepts. An alias of {@link PromptsDefinition} — kept as a
 * name because `withX` options types are part of the adopter vocabulary, but
 * structurally identical: there is one shape, not a parallel one.
 *
 * GONE (ADR 93): `initial` and `loaders`, the parallel source-config vocabulary.
 * Sources are named hydrators now — `withPrompts({ initial: prompts })` becomes
 * `withPrompts({ hydrate: hydrateFrom(prompts) })`, and
 * `withPrompts({ loaders: [a, b] })` becomes
 * `withPrompts({ hydrate: composeHydrators(a, b) })`. Also gone: `use:` — the
 * live-instance escape hatch is the DICHOTOMY's second arm
 * (`withPrompts(myHarness)`), not a nested slot.
 *
 * NEW (ADR 93 rendered-moot #4): `store`. The withPrompts-lacks-a-store asymmetry
 * against `withSkills` is over.
 */
export type WithPromptsOptions = PromptsDefinition;

// TODO(tools-sweep / three-audiences-plan §D): a `src/tools.ts` shipping
// model-facing `prompt_*` tools (e.g. `prompt_list` / `prompt_get`) would slot in
// here behind a `registerModelTools` option, same shape as
// `resources/src/tools.ts` + `skills/src/tools.ts`. DEFERRED: prompts are
// USER-controlled (invoked by the human, not model-discovered), so a model-facing
// surface needs its audience story told first. When added: reach the harness
// through a `ctx.prompts` slot (NOT `ctx.session`) + augment
// `ToolHandlerCtxExtensions`.
export function withPrompts(config: PromptsConfig = {}): SessionExtension {
  return {
    name: "@agentick/prompts",
    target: "session",
    install: async (installer: SessionInstaller) => {
      // ── Live-instance arm: register and get out of the way. The adopter owns
      // construction, genesis, and teardown.
      if (isPromptsInstance(config)) {
        installer.registerNamespace("prompts", config);
        // `prompt://<name>` projection (default-on). Reads the live instance; our
        // resource registrations + subscription unwind on close WITHOUT closing
        // the adopter-owned harness.
        //
        // TODO(D-phase): the live-instance arm carries no `exposeAsResources`
        // toggle, because the dichotomy's second arm is an INSTANCE, not a config
        // bag — and nesting install options beside it is the config-wrapper
        // ADR 93 kills. The door is therefore default-on for a BYO harness.
        wirePromptProjection(installer, config);
        return;
      }

      // ── Definition arm: construct THIS session's harness from the plan.
      //
      // Read the session's timeline harness if available — `invoke()` uses it to
      // append rendered messages to the durable timeline. When absent (e.g. a test
      // setup), `invoke()` renders and returns without appending.
      const timeline = (installer.getNamespace?.("timeline") ?? undefined) as
        | import("@agentick/spec").TimelineHarnessProtocol
        | undefined;

      const harness = new PromptsHarness(
        `${installer.hostId}:prompts`,
        installer.substrate.journal,
        installer.substrate.bus,
        installer.substrate.inbox,
        {
          ...config,
          ...(timeline ? { timeline } : {}),
          // ADR 93 landmine 11 — the cascade must be TOTAL. An extension-installed
          // namespace inherits the app/session interceptor cascade through the
          // installer's handle, exactly like a session-constructed bridge does;
          // without this an app `guard`/`hook` silently skips it.
          ...inheritedFrom(installer),
        },
      );
      await harness.ready;

      // GENESIS (ADR 93) — before the harness is visible to any renderer. A no-op
      // when the definition names no hydrator, so the zero-config path stays
      // zero-cost. A throw fails the install, which fails session creation with
      // `PromptsHydrateFailed` — no half-genesis catalog.
      await harness.hydrate();

      // `prompt://<name>` projection (default-on) — the prompt catalog becomes
      // addressable through the standard resources surface. LIVE via the harness
      // change-subscription; content served honestly (string template as text,
      // else a declaration document — never a serialized function).
      if (config.exposeAsResources !== false) {
        wirePromptProjection(installer, harness);
      }

      installer.registerNamespace("prompts", harness);
      installer.onClose(() => harness.close());
    },
  };
}
