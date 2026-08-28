/**
 * `defineSkills` — the skills NAMESPACE DEFINITION (ADR 93 D3).
 *
 * A store-bearing namespace is configured by a **definition**: the durability
 * port (`store`), the genesis seam (`hydrate`), that namespace's shaping verbs
 * (`composeRun`, `registerModelTools`, `exposeAsResources`), and the `hooks:` /
 * `guards:` bags. One definition object is consumed by BOTH
 * `createApp({ skills })` and `withSkills(...)`, and is what a namespace file
 * default-exports.
 *
 * ## The definition IS the options
 *
 * `defineSkills` is **identity + brand** — it returns its argument, stamped. The
 * value is portability, not construction: a grammar file default-exports one, a
 * test imports the production definition and overrides a slot, and the brand
 * lets a slot tell a definition from a live harness instance. Nothing is
 * constructed and no hydrator runs: **definitions are INERT until install**.
 * Construction is PER-SESSION at install; genesis runs at session-open with
 * that session's reality.
 *
 * ## The genesis seam — and the source unification
 *
 * `hydrate(ctx)` returns the skills the session opens with, and it is the ONE
 * source seam. Where the library used to carry a parallel source vocabulary
 * (`initial:` literal records PLUS a `loaders:` array of `SkillLoader`s), a
 * source is now a NAMED HYDRATOR: `hydrateFrom(records)`,
 * `hydrateFromDirectory({ path })`, `hydrateFromUrl({ url })`,
 * `hydrateFromStore()`, composed with `composeHydrators(...)`. A tiered catalog
 * is a hydrator reading `ctx.principal`; an event-sourced catalog is a hydrator
 * folding `ctx.journalReader`. Genesis became something an adopter WRITES.
 *
 * Unlike the timeline, skills names **no default hydrator**: configuring a
 * `store` does not implicitly load it. A skill library is a CATALOG, and which
 * slice of a catalog a session should open with is a policy question (whole
 * store? this principal's tier? the on-disk directory, store be damned?) with no
 * safe default. Ask for it: `hydrate: hydrateFromStore()`.
 *
 * **Genesis output is SEED, never re-registered.** The records a hydrator
 * returns are adopted into the read view WITHOUT a `skills:register` op and
 * WITHOUT a store write. Writing genesis back would duplicate the catalog on
 * every resume — and for a store-read hydrator it would write the store back
 * onto itself. This is the #1 adopter footgun.
 *
 * @see docs/proposals/v2/blueprint/93-namespace-definitions.md
 * @see ./hydrators.ts — the universal named hydrators
 * @see ./hydrators-node.ts — the filesystem sources (`@agentick/skills/hydrators/node`)
 * @verifiedBy packages/skills/src/__tests__/definition.spec.ts
 */

import type {
  CollectionMutation,
  OperationCtx,
  Skill,
  SkillStoreQuery,
  Skills,
  SkillsRegisterInput,
  Store,
} from "@agentick/spec";
import type { HarnessInterceptors } from "@agentick/runtime";

import type { SkillRunCompose } from "./handle.js";

/**
 * The brand `defineSkills` stamps. Symbol-keyed so it never collides with an
 * adopter property and stays out of `JSON.stringify` / spread-visible shape —
 * the definition remains a plain data bag for every other purpose.
 */
const SKILLS_DEFINITION: unique symbol = Symbol("agentick.skillsDefinition");

/** The store port skills is written against: a keyed collection of whole `Skill` records. */
export type SkillsStore = Store<Skill, SkillStoreQuery, CollectionMutation<Skill>>;

/**
 * What a {@link SkillsHydrator} yields: a register input that MAY carry its own
 * `createdAt` / `updatedAt`.
 *
 * Genesis is not registration — a hydrator often replays records that are already
 * durable (`hydrateFromStore`) or that carry a source's own provenance, and
 * stamping those with `Date.now()` at seed time would erase real history. So the
 * timestamps are optional inputs, defaulted at seed only when absent. A whole
 * {@link Skill} is assignable here, which is what makes `store.query` a hydrator
 * body with no repacking.
 */
export type SkillSeed = SkillsRegisterInput & {
  readonly createdAt?: number;
  readonly updatedAt?: number;
};

// ============================================================================
// The genesis seam
// ============================================================================

/**
 * The ctx a {@link SkillsHydrator} receives: the session's derived
 * {@link OperationCtx} (identity + causality + `log`/`trace`/`metrics`/`run`)
 * plus the definition's own store as a typed facet.
 *
 * `ctx.principal` (ADR 48) is the TIERED-CATALOG seam — a hydrator that returns
 * a different skill set per owner is a plain function of this ctx, needing no
 * framework support:
 *
 * ```ts
 * defineSkills({ hydrate: (ctx) => catalogForTier(tierOf(ctx.principal)) })
 * ```
 *
 * `TStore` flows from the definition's `store` slot, so a hydrator written
 * against `defineSkills({ store: myPostgresStore, hydrate: (ctx) => … })` sees
 * `ctx.store` typed as that adapter — including verbs it adds beyond the port.
 */
export interface SkillsHydrateCtx<TStore extends SkillsStore = SkillsStore> extends OperationCtx {
  /** The definition's store — the durability/query port, as a boundary facet. */
  readonly store: TStore;
}

/**
 * The genesis seam (ADR 93): produce the skills the session opens with. Runs on
 * CREATE and RESUME, never for an INHERITING child — a fork, a reply, or a
 * spawn with `branch` (it inherits the source's image; re-running genesis would
 * duplicate or diverge it). Runs after identity stamping and before first
 * render — and a rejection FAILS session creation with `SkillsHydrateFailed`
 * (no half-genesis session).
 *
 * The returned records are a SEED: never registered as ops, never written back
 * to the store.
 *
 * Also the source `reload()` and `resolve(name)` re-run — one seam, not two.
 */
export type SkillsHydrator<TStore extends SkillsStore = SkillsStore> = (
  ctx: SkillsHydrateCtx<TStore>,
) => Promise<readonly SkillSeed[]>;

// ============================================================================
// The definition
// ============================================================================

/**
 * The skills namespace definition — the CLOSED surface (ADR 93 §"Definition
 * surface — complete and closed"): the store, the genesis seam, this namespace's
 * shaping seams, and the two interceptor bags. Nothing else belongs here;
 * wire-exposure grants live at the gateway, telemetry is a trunk field, channels
 * are the bus.
 *
 * This same type is what `withSkills(...)` and `createApp({ skills })` accept
 * inline — `defineSkills` adds identity + the brand, not a new shape.
 */
export interface SkillsDefinition<
  TStore extends SkillsStore = SkillsStore,
> extends HarnessInterceptors<"skills"> {
  /**
   * Durable backing for skill records — the durability/query port. Defaults to a
   * fresh per-session in-memory `InMemorySkillStore` (lost on exit). Inject a
   * durable adapter conforming to the `Store` seam to survive process restart;
   * `runSkillStoreConformance` certifies it.
   *
   * A store on its own loads NOTHING — pair it with `hydrate:
   * hydrateFromStore()`. See the module doc for why skills names no default.
   */
  readonly store?: TStore;
  /**
   * The genesis seam. **Default none** — a definition with neither a store read
   * nor a source hydrator opens an empty library, which is what a zero-config
   * session has always done.
   *
   * Declared as a METHOD signature, not a function-typed property, and
   * deliberately so (ADR 93 landmine 6). `TStore` appears here in a PARAMETER
   * position, so a property declaration would make `SkillsDefinition` invariant
   * under `strictFunctionTypes` — and then `defineSkills({ store: myPgStore,
   * hydrate })` would not fit a slot typed at the PORT
   * (`SkillsDefinition<SkillsStore>`), which is every slot. Method params are
   * checked bivariantly, which is the correct trade here: the store a definition
   * names and the store its hydrator receives are the same object by
   * construction.
   */
  hydrate?(ctx: SkillsHydrateCtx<TStore>): Promise<readonly SkillSeed[]>;
  /**
   * The `skills.run` composition seam: maps a resolved skill + run options to
   * the `SendInput` the runner executes. Defaults to `defaultComposeRun`
   * (system-role skill message + user-role args message) — a generous default,
   * but this seam is the truth.
   */
  readonly composeRun?: SkillRunCompose;
  /**
   * Register the model-facing `skill_list` / `skill_read` tools. Default `true`
   * — a model discovers and reads the session's skills with no extra wiring
   * (progressive disclosure). Set `false` for the substrate without the model
   * surface: skills consumed only by adopter code (`session.skills`) or over an
   * MCP-server projection.
   */
  readonly registerModelTools?: boolean;
  /**
   * Project each skill as a read-only `skill://<name>` resource on the session's
   * resources harness. Default `true` — every skill's BODY becomes addressable
   * through the standard resources surface (and the MCP projection), completing
   * the story whose `skill://<name>/references/*` files are already resources.
   * The projection is LIVE: skills registered or removed after install project
   * or unregister via the harness change-subscription. Set `false` to keep
   * skills off the resources surface.
   */
  readonly exposeAsResources?: boolean;
}

/** A {@link SkillsDefinition} carrying the {@link defineSkills} brand. */
export type BrandedSkillsDefinition<TStore extends SkillsStore = SkillsStore> =
  SkillsDefinition<TStore> & { readonly [SKILLS_DEFINITION]: true };

/**
 * Name a skills definition (ADR 93). Identity + brand — it returns `options`
 * with the definition brand stamped; nothing is constructed, no store is
 * opened, no hydrator runs.
 *
 * ```ts
 * export default defineSkills({
 *   store: postgresSkillStore({ executor: pool }),
 *   hydrate: composeHydrators(hydrateFromStore(), hydrateFromDirectory({ path: ".agents/skills" })),
 *   guards: { register: (input) => (input.name.startsWith("_") ? { kind: "veto" } : undefined) },
 * });
 * ```
 */
export function defineSkills<TStore extends SkillsStore = SkillsStore>(
  options: SkillsDefinition<TStore> = {},
): BrandedSkillsDefinition<TStore> {
  return Object.defineProperty(options, SKILLS_DEFINITION, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  }) as BrandedSkillsDefinition<TStore>;
}

/**
 * Does `value` carry the {@link defineSkills} brand? Note that an INLINE bag
 * (`withSkills({ store })`) is a perfectly valid definition and is NOT branded —
 * so slots discriminate a definition from a LIVE HARNESS with spec's
 * `isSkillsInstance`, and use this only when the brand itself is the question
 * (introspection, tooling).
 */
export function isSkillsDefinition(value: unknown): value is BrandedSkillsDefinition {
  return typeof value === "object" && value !== null && SKILLS_DEFINITION in value;
}

/**
 * What `withSkills` / the `skills` slot accept — the ADR-42 dichotomy, no third
 * form: a DEFINITION (declarative, inert until install, constructed per-session)
 * or a LIVE INSTANCE (the adopter owns its lifecycle).
 */
export type SkillsConfig = SkillsDefinition | Skills;
