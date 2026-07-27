/**
 * `withSkills()` — the DYNAMIC install form for the SkillsHarness.
 *
 * Two ways to configure a session's skills, one type:
 *
 *   - `createApp({ skills: defineSkills({...}) })` — the top-level SLOT
 *     (ADR 93), lit by this package's `augment.ts`. The normal path.
 *   - `extensions: [withSkills({...})]` — the fully-dynamic escape hatch
 *     (runtime-built arrays, conditional composition). Installs the same
 *     harness; an explicit entry here OVERRIDES the slot, because extensions run
 *     after the slot-minted install and namespace registration is
 *     last-writer-wins.
 *
 * Both take the SAME {@link SkillsDefinition} — "the definition IS the options"
 * (ADR 93 §Composition ruling). A live `Skills` instance is also accepted: the
 * BYO / single-session escape hatch, whose lifecycle the adopter owns (so it is
 * NOT closed on session close, and genesis is NOT run — an instance the adopter
 * built is an instance the adopter has already prepared).
 *
 * @see docs/proposals/v2/blueprint/93-namespace-definitions.md
 * @see ./augment.ts — the top-level slot registration
 */

import {
  isSkillsInstance,
  type Resources,
  type SessionExtension,
  type SessionInstaller,
  type SkillsRegisterInput,
  type Unsubscribe,
} from "@agentick/spec";
import { inheritedFrom } from "@agentick/runtime";

import { SkillsHarness } from "./harness.js";
import type { SkillsConfig, SkillsDefinition } from "./definition.js";
import { readSkillReferenceWiring } from "./references.js";
import { wireSkillProjection } from "./projection.js";
import { buildSkillsTools } from "./tools.js";

/**
 * Options `withSkills` accepts. An alias of {@link SkillsDefinition} — kept as a
 * name because `withX` options types are part of the adopter vocabulary, but
 * structurally identical: there is one shape, not a parallel one.
 *
 * GONE (ADR 93): `initial` and `loaders`, the parallel source-config vocabulary.
 * Sources are named hydrators now — `withSkills({ initial: skills })` becomes
 * `withSkills({ hydrate: hydrateFrom(skills) })`, and
 * `withSkills({ loaders: [a, b] })` becomes
 * `withSkills({ hydrate: composeHydrators(a, b) })` where `a`/`b` are hydrators.
 * Also gone: `use:` — the live-instance escape hatch is the DICHOTOMY's second
 * arm (`withSkills(myHarness)`), not a nested slot.
 */
export type WithSkillsOptions = SkillsDefinition;

export function withSkills(config: SkillsConfig = {}): SessionExtension {
  return {
    name: "@agentick/skills",
    target: "session",
    install: async (installer: SessionInstaller) => {
      // Auto-register `skill_list` / `skill_read` (default-on). The handlers reach
      // the session's `Skills` via `ctx.skills` at dispatch — the SAME instance
      // registered under the `skills` namespace below, which the AppHarness
      // threads into `ctx.skills`.
      const mountModelTools = (registerModelTools: boolean | undefined): void => {
        if (registerModelTools === false) return;
        const bundle = buildSkillsTools(installer.sessionId);
        for (const { handlerRef, handler } of bundle.handlers) {
          installer.registerToolHandler(handlerRef, handler);
        }
        for (const registration of bundle.registrations) {
          installer.registerExtensionTool(registration);
        }
      };

      // ── Live-instance arm: register and get out of the way. The adopter owns
      // construction, genesis, and teardown — we do not close what we did not
      // open, and we do not re-run genesis on an already-prepared instance.
      if (isSkillsInstance(config)) {
        installer.registerNamespace("skills", config);
        mountModelTools(undefined);
        // `skill://<name>` body projection (default-on). Reads the live instance;
        // our resource registrations + subscription unwind on close WITHOUT
        // closing the adopter-owned harness.
        //
        // TODO(D-phase): the live-instance arm carries no `registerModelTools` /
        // `exposeAsResources` toggle, because the dichotomy's second arm is an
        // INSTANCE, not a config bag — and nesting install options beside it is
        // the config-wrapper ADR 93 kills. Both doors are therefore default-on
        // for a BYO harness. If an adopter needs one off with a BYO backing, the
        // answer today is the definition arm with a `store` that fronts their
        // source. Revisit if a third consumer wants instance-plus-exposure.
        wireSkillProjection(installer, config);
        return;
      }

      // ── Definition arm: construct THIS session's harness from the plan.
      const harness = new SkillsHarness(
        `${installer.hostId}:skills`,
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
        },
      );
      await harness.ready;

      // GENESIS (ADR 93) — before the harness is visible to any renderer.
      // A no-op when the definition names no hydrator, so the zero-config path
      // stays zero-cost. A throw fails the install, which fails session creation
      // with `SkillsHydrateFailed` — no half-genesis library.
      await harness.hydrate();

      // E2 — supporting files ride the RESOURCES harness (composition, not new
      // machinery). Skills produced by `hydrateFromDirectory` carry transient
      // wiring for each `references/*` file; register each as a TRANSIENT resource
      // so the model pulls it via `resource_read`. Read off the SEEDED records
      // (the live view), because the wiring closures do not survive a store
      // round-trip.
      wireSkillReferences(installer, harness.list());

      // `skill://<name>` body projection (default-on) — the second half of E2: the
      // reference FILES are already `skill://<name>/references/*` resources; this
      // makes the skill BODY addressable too. LIVE via the harness
      // change-subscription. Distinct uris from the reference wiring above.
      if (config.exposeAsResources !== false) {
        wireSkillProjection(installer, harness);
      }

      installer.registerNamespace("skills", harness);
      installer.onClose(() => harness.close());
      mountModelTools(config.registerModelTools);
    },
  };
}

/**
 * Register each skill's `references/*` files as TRANSIENT resources on the
 * session's resources harness (`installer.resources` — the SAME registry
 * `withMCP` proxy-registers remote resources into; composition, not new
 * machinery). The resolver closures were built on the Node hydrator side
 * (`hydrators-node.ts` — `node:fs`), so this universal install path never touches
 * `node:*`; it only reads the wiring off the record and registers it.
 *
 * Degradation: `installer.resources` is host-constructed and normally always
 * present, but a stub installer may omit it — guard so skills still load and no
 * throw escapes. Uniqueness: `skill://` uris are namespaced by skill name, so
 * collisions only arise on duplicate skill names, which the seed keys by name
 * already collapses; a stray `ResourceAlreadyRegistered` is swallowed per-item so
 * it cannot abort the rest of the wiring.
 */
function wireSkillReferences(
  installer: SessionInstaller,
  records: readonly SkillsRegisterInput[],
): void {
  const resources = installer.resources as Resources | undefined;
  if (!resources) return; // no resources harness → skills still load, no throw

  const unsubs: Unsubscribe[] = [];
  for (const record of records) {
    for (const wiring of readSkillReferenceWiring(record)) {
      try {
        unsubs.push(resources.register(wiring.uri, wiring.resolver, wiring.meta));
      } catch {
        // Duplicate uri — the first registration wins; skip.
      }
    }
  }

  if (unsubs.length > 0) {
    installer.onClose(() => {
      for (const unsub of unsubs) unsub();
    });
  }
  // TODO(E2-reload): references are wired ONCE at install from genesis output. A
  // post-install `skills.reload()` / per-skill removal does NOT re-sync
  // (drop+rewire) these reference resources, and snapshot/restore drops the
  // transient resolver closures (functions don't serialize) so references do not
  // re-register on restore. When reload-sync lands, retain the unsubs keyed by
  // skill name and drop/rewire per mutated skill.
}
