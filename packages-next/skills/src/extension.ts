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
  type Store,
  type SessionExtension,
  type SessionInstaller,
  type Skill,
  type SkillStoreQuery,
  type Skills,
  type SkillsRegisterInput,
} from "@agentick/spec-next";
import { omitUndefined } from "@agentick/utils-next";
import { SkillsHarness } from "./harness.js";
import type { SkillRunCompose } from "./handle.js";
import type { SkillLoader } from "./loaders.js";

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
   * See `@agentick/skills-next/loaders` for the `fromArray` / `fromUrl`
   * / `fromManifest` factories, and `@agentick/skills-next/loaders/node`
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
}

/**
 * Top-level slot shape accepted by `withSkills`. Per ADR 42 — array,
 * instance, OR config object. See file-level comment for semantics.
 */
export type WithSkillsSlot = readonly SkillsRegisterInput[] | Skills | WithSkillsOptions;

export function withSkills(slot: WithSkillsSlot = {}): SessionExtension {
  const options = resolveSlot(slot);
  return {
    name: "@agentick/skills-next",
    target: "session",
    install: async (installer: SessionInstaller) => {
      // ──────── Form B (instance) — adopter owns lifecycle ────────
      if (options.use !== undefined) {
        installer.registerNamespace("skills", options.use);
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

      // Seed initial skills via the async surface so envelopes flow
      // through the journal — adopters subscribing to `skills:register`
      // see them on session boot.
      if (options.initial && options.initial.length > 0) {
        for (const skill of options.initial) {
          await harness.register(skill);
        }
      }

      if (options.loaders && options.loaders.length > 0) {
        const batches = await Promise.all(options.loaders.map((l) => l.load()));
        for (const batch of batches) {
          for (const skill of batch) {
            await harness.register(skill);
          }
        }
      }

      installer.registerNamespace("skills", harness);
      installer.onClose(() => harness.close());
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
