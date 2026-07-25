/**
 * `withSkills()` — `SessionExtension` factory.
 *
 * Constructs a {@link SkillsHarness} per-session at session install
 * time, wired to the session's substrate. Adopters who want a
 * custom backend (sqlite-backed, remote registry) pass a configured
 * `withSkills({ ... })` — or hand in their own pre-built `Skills`
 * instance via the `use:` escape hatch (or top-level shorthand).
 *
 * Per ADR 42 §"slot trichotomy" the slot accepts three shapes:
 *
 *   1. `readonly SkillsRegisterInput[]` — array shorthand. Same as
 *      `{ initial: [...] }`. Server builds the per-session harness
 *      internally and registers the supplied skills at install time.
 *   2. `Skills` (= `SkillsHarnessProtocol`) — instance shorthand. The
 *      extension uses the adopter-supplied harness as-is across every
 *      session (no per-session construction; no close on session
 *      teardown). Adopter owns the lifecycle.
 *   3. {@link WithSkillsOptions} — config object: `initial` /
 *      `loaders` (built-in path) OR `use` (adopter-supplied instance).
 *
 * Discrimination is structural — arrays go to form 1, anything that
 * structurally matches `Skills` goes to form 2, plain objects go to
 * form 3.
 *
 * @see docs/proposals/v2/blueprint/32-extension-shape-spectrum.md
 * @see docs/proposals/v2/blueprint/42-harness-slot-trichotomy.md
 */

import {
  isSkillsInstance,
  type CollectionMutation,
  type Resources,
  type Store,
  type SessionExtension,
  type SessionInstaller,
  type Skill,
  type SkillStoreQuery,
  type Skills,
  type SkillsRegisterInput,
  type Unsubscribe,
} from "@agentick/spec";
import { omitUndefined } from "@agentick/utils";
import { SkillsHarness } from "./harness.js";
import type { SkillRunCompose } from "./handle.js";
import type { SkillLoader } from "./loaders.js";
import { readSkillReferenceWiring } from "./references.js";
import { wireSkillProjection } from "./projection.js";
import { buildSkillsTools } from "./tools.js";

export interface WithSkillsOptions {
  /**
   * Initial skill set seeded at session construction. Useful for
   * shipping bundled "starter" skills (e.g., framework-defined
   * recipes) or for restore-from-snapshot at startup.
   */
  readonly initial?: readonly SkillsRegisterInput[];
  /**
   * Skill loaders evaluated at install time. All loaders run
   * concurrently; their outputs concatenate (input order) and are
   * registered after `initial`. Duplicate `name` between sources
   * raises `SkillAlreadyExists` from the harness — wrap loaders or
   * dedupe upstream if your inputs may overlap.
   *
   * See `@agentick/skills/loaders` for the `fromArray` / `fromUrl`
   * / `fromManifest` factories, and `@agentick/skills/loaders/node`
   * for `fromFile` / `fromDirectory`.
   */
  readonly loaders?: readonly SkillLoader[];
  /**
   * Durable backing for skill records (data-layer plan §6-C). Defaults to a
   * fresh per-session in-memory store; inject a durable adapter (Postgres, a
   * filesystem source) conforming to the {@link Store} seam to survive
   * process restart. Built-in path only — mutually exclusive with `use` (an
   * adopter-supplied instance brings its own backing).
   */
  readonly store?: Store<Skill, SkillStoreQuery, CollectionMutation<Skill>>;
  /**
   * The `skills.run` composition seam (three-audiences-plan §C). A
   * `(skill, opts) => SendInput` callback the framework calls to prime the
   * skill's run; the default (system-role skill message + user-role args
   * message) ships built-in, this seam is the truth. Built-in path only — an
   * adopter-supplied `use:` instance owns its own composition.
   */
  readonly composeRun?: SkillRunCompose;
  /**
   * Adopter-supplied `Skills` instance. The extension uses this as-is
   * across every session — NO per-session construction, NO close on
   * session teardown. Use this when one source-of-truth should back
   * many sessions (a shared on-disk DB, a remote registry, a cluster-
   * wide replica).
   *
   * Mutually exclusive with `initial` / `loaders` — if you bring your
   * own instance, you also own seeding + reload. The extension still
   * publishes the instance under the session's `skills` namespace so
   * tools, getters, and bridges resolve to it.
   */
  readonly use?: Skills;
  /**
   * Skip auto-registering the model-facing `skill_*` tools (`skill_list`
   * / `skill_read`). Defaults to `false` — by default `withSkills()`
   * registers them so a model can discover + read the session's skills
   * with zero extra wiring (progressive disclosure). Set `true` for the
   * harness substrate without the model surface — e.g. skills consumed
   * exclusively by adopter code (`session.skills`) or over an MCP-server
   * projection, with no LLM discovering them in-band.
   */
  readonly registerModelTools?: boolean;
  /**
   * Project each registered skill as a read-only `skill://<name>` resource on
   * the session's resources harness. Defaults to `true` — every skill's BODY
   * becomes addressable through the standard resources surface (and the MCP
   * projection) with zero bespoke wire work, completing the E2 story whose
   * `skill://<name>/references/*` files are already resources. The projection is
   * LIVE (skills registered / removed after install project / unregister via the
   * harness change-subscription) and reads content from the live harness at read
   * time. Set `false` for the harness substrate without the uniform-addressing
   * door — e.g. skills reached exclusively by the `skill_read` model tool or by
   * adopter code (`session.skills`). Coexists with `registerModelTools`: two
   * doors, one capability (three-audiences-plan §0).
   */
  readonly exposeAsResources?: boolean;
}

/**
 * Top-level slot shape accepted by `withSkills`. Per ADR 42 — array,
 * instance, OR config object. See file-level comment for semantics.
 */
export type WithSkillsSlot = readonly SkillsRegisterInput[] | Skills | WithSkillsOptions;

export function withSkills(slot: WithSkillsSlot = {}): SessionExtension {
  const options = resolveSlot(slot);
  return {
    name: "@agentick/skills",
    target: "session",
    install: async (installer: SessionInstaller) => {
      // Auto-register `skill_list` / `skill_read` (default-on). The
      // handlers reach the session's `Skills` via `ctx.skills` at dispatch
      // — the SAME instance registered under the `skills` namespace below,
      // which the AppHarness threads into `ctx.skills`. Registered in BOTH
      // the instance and built-in branches: the namespace is present in
      // both, so the model surface works identically. Same install-time
      // pattern as `withResources`.
      const mountModelTools = (): void => {
        if (options.registerModelTools === false) return;
        const bundle = buildSkillsTools(installer.sessionId);
        for (const { handlerRef, handler } of bundle.handlers) {
          installer.registerToolHandler(handlerRef, handler);
        }
        for (const registration of bundle.registrations) {
          installer.registerExtensionTool(registration);
        }
      };

      // ──────── Form B (instance) — adopter owns lifecycle ────────
      if (options.use !== undefined) {
        installer.registerNamespace("skills", options.use);
        mountModelTools();
        // `skill://<name>` body projection (default-on). Reads the live
        // instance; our resource registrations + subscription unwind on close
        // WITHOUT closing the adopter-owned harness.
        if (options.exposeAsResources !== false) {
          wireSkillProjection(installer, options.use);
        }
        // Intentionally NO `onClose(() => harness.close())` — adopter
        // brought the instance, adopter closes it.
        return;
      }

      // ──────── Forms A / C (built-in path) ────────
      const harness = new SkillsHarness(
        `${installer.hostId}:skills`,
        installer.substrate.journal,
        installer.substrate.bus,
        installer.substrate.inbox,
        omitUndefined({ store: options.store, composeRun: options.composeRun }),
      );
      await harness.ready;

      // Retain loaders for post-startup `reload()` / `resolve(name)`.
      if (options.loaders && options.loaders.length > 0) {
        harness.setLoaders(options.loaders);
      }

      // Accumulate every registered input record — the in-memory records
      // (NOT the harness round-trip, which may drop the transient reference
      // resolver closures on serialize) carry the E2 reference wiring.
      const registered: SkillsRegisterInput[] = [];

      // Seed initial skills via the async surface so envelopes flow
      // through the journal — adopters subscribing to `skills:register`
      // see them on session boot.
      if (options.initial && options.initial.length > 0) {
        for (const skill of options.initial) {
          await harness.register(skill);
          registered.push(skill);
        }
      }

      if (options.loaders && options.loaders.length > 0) {
        const batches = await Promise.all(options.loaders.map((l) => l.load()));
        for (const batch of batches) {
          for (const skill of batch) {
            await harness.register(skill);
            registered.push(skill);
          }
        }
      }

      // E2 — supporting files ride the RESOURCES harness (composition, not new
      // machinery). Skills discovered by `agentSkillsDirectory` carry transient
      // wiring for each `references/*` file; register each as a TRANSIENT
      // resource so the model pulls it via `resource_read`.
      wireSkillReferences(installer, registered);

      // `skill://<name>` body projection (default-on) — the second half of E2:
      // the reference FILES are already `skill://<name>/references/*` resources;
      // this makes the skill BODY addressable too. LIVE via the harness
      // change-subscription (dynamic register / remove re-sync). Distinct uris
      // from the reference wiring above — both coexist.
      if (options.exposeAsResources !== false) {
        wireSkillProjection(installer, harness);
      }

      installer.registerNamespace("skills", harness);
      installer.onClose(() => harness.close());
      mountModelTools();
    },
  };
}

/**
 * Normalize the trichotomic slot into a {@link WithSkillsOptions}
 * shape the install path consumes uniformly. Exported for tests +
 * adopters who want to inspect the resolved shape; the slot itself
 * is the public surface.
 */
export function resolveSlot(slot: WithSkillsSlot): WithSkillsOptions {
  if (Array.isArray(slot)) {
    return { initial: slot };
  }
  if (isSkillsInstance(slot)) {
    return { use: slot };
  }
  const cfg = slot as WithSkillsOptions;
  if (
    cfg.use !== undefined &&
    (cfg.initial !== undefined || cfg.loaders !== undefined || cfg.store !== undefined)
  ) {
    throw new Error(
      "withSkills: `use:` is mutually exclusive with `initial` / `loaders` / `store` — " +
        "adopter-supplied instances own their seeding, reload, and durable backing.",
    );
  }
  return cfg;
}

/**
 * Register each skill's `references/*` files as TRANSIENT resources on the
 * session's resources harness (`installer.resources` — the SAME registry
 * `withMCP` proxy-registers remote resources into; composition, not new
 * machinery). The resolver closures were built on the Node loader side
 * (`loaders-node.ts` — `node:fs`), so this universal install path never touches
 * `node:*`; it only reads the wiring off the record and registers it.
 *
 * Degradation: `installer.resources` is host-constructed and normally always
 * present, but a stub installer may omit it — guard so skills still load and no
 * throw escapes. Uniqueness: `skill://` uris are namespaced by skill name, so
 * collisions only arise on duplicate skill names, which `SkillAlreadyExists`
 * already rejects upstream; a stray `ResourceAlreadyRegistered` is swallowed
 * per-item so it cannot abort the rest of the wiring.
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
        // Duplicate uri (its owning skill name already collided upstream) — the
        // first registration wins; skip.
      }
    }
  }

  if (unsubs.length > 0) {
    installer.onClose(() => {
      for (const unsub of unsubs) unsub();
    });
  }
  // TODO(E2-reload): references are wired ONCE at install from loader output. A
  // post-install `skills.reload()` / per-skill removal does NOT re-sync
  // (drop+rewire) these reference resources, and snapshot/restore drops the
  // transient resolver closures (functions don't serialize) so references do
  // not re-register on restore. When reload-sync lands, retain the unsubs keyed
  // by skill name and drop/rewire per mutated skill.
}
