/**
 * `definePrompts` — the prompts NAMESPACE DEFINITION (ADR 93 D3).
 *
 * A store-bearing namespace is configured by a **definition**: the durability
 * port (`store`), the genesis seam (`hydrate`), that namespace's shaping verbs
 * (`renderers`, `exposeAsResources`), and the `hooks:` / `guards:` bags. One
 * definition object is consumed by BOTH `createApp({ prompts })` and
 * `withPrompts(...)`, and is what a namespace file default-exports.
 *
 * ## The store-option asymmetry is gone
 *
 * `withPrompts` used to have no `store` at all, while `withSkills` did — the same
 * archetype with half the port (ADR 93 rendered-moot #4). It has one now. What
 * the store holds is narrower than skills': ONLY the serializable
 * `PromptDeclarationRecord`. A prompt's `render(args, ctx)` function, its
 * `template`, and any inline `complete` resolver on its arguments live in the
 * harness's augmentation sidecar and never reach the store, because a function
 * does not serialize. A hydrated prompt therefore has
 * record-only content until the adopter re-registers its content — which is
 * exactly why {@link hydrateFromModule} exists: a module import is the one source
 * that carries functions across the load boundary.
 *
 * ## The definition IS the options
 *
 * `definePrompts` is **identity + brand** — it returns its argument, stamped.
 * Nothing is constructed and no hydrator runs: **definitions are INERT until
 * install**. Construction is PER-SESSION at install; genesis runs at
 * session-open with that session's reality.
 *
 * ## The genesis seam
 *
 * `hydrate(ctx)` returns the prompts the session opens with, and it is the ONE
 * source seam — `hydrateFrom(records)`, `hydrateFromModule({ specifier })`,
 * `hydrateFromStaticUrl({ url })`, `hydrateFromStore()`, composed with
 * `composeHydrators(...)`. **Default none**, like skills: a `store` alone loads
 * nothing.
 *
 * **Genesis output is SEED, never re-registered.** No `prompts:register` op, no
 * store write.
 *
 * @see docs/proposals/v2/blueprint/93-namespace-definitions.md
 * @see ./hydrators.ts — the named hydrators
 * @verifiedBy packages/prompts/src/__tests__/definition.spec.ts
 */

import type {
  CollectionMutation,
  OperationCtx,
  PromptDeclarationRecord,
  PromptStoreQuery,
  Prompts,
  PromptsRegisterInput,
  Store,
} from "@agentick/spec";
import type { NamespaceGuards, NamespaceHooks } from "@agentick/runtime";

import type { PromptRenderer } from "./renderer.js";

/**
 * The brand `definePrompts` stamps. Symbol-keyed so it never collides with an
 * adopter property and stays out of `JSON.stringify` / spread-visible shape.
 */
const PROMPTS_DEFINITION: unique symbol = Symbol("agentick.promptsDefinition");

/**
 * The store port prompts is written against: a keyed collection of the
 * SERIALIZABLE declaration slice. The `{ template, render }` augmentation is
 * excluded by the record type, as is each argument's inline `complete` resolver
 * (`PromptArgumentRecord` trades it for a `completeRef` string and types
 * `complete?: never`) — a compile-time guarantee that a CODE-carrying field
 * never reaches durability. Note the record is not thereby fully JSON-safe: an
 * argument's `schema` survives it and carries a `~standard.validate` function.
 * That wart predates the completion split and is not what the split claims.
 */
export type PromptsStore = Store<
  PromptDeclarationRecord,
  PromptStoreQuery,
  CollectionMutation<PromptDeclarationRecord>
>;

/**
 * What a {@link PromptsHydrator} yields — the same register input `prompts.register`
 * takes, so a source is free to carry a `render` function when its transport can
 * (a module import) and free to omit it when it cannot (a URL manifest).
 */
export type PromptSeed = PromptsRegisterInput;

// ============================================================================
// The genesis seam
// ============================================================================

/**
 * The ctx a {@link PromptsHydrator} receives: the session's derived
 * {@link OperationCtx} (identity + causality + `log`/`trace`/`metrics`/`run`)
 * plus the definition's own store as a typed facet.
 *
 * `ctx.principal` (ADR 48) is the per-tenant-catalog seam — a hydrator returning
 * a different prompt set per owner is a plain function of this ctx.
 */
export interface PromptsHydrateCtx<
  TStore extends PromptsStore = PromptsStore,
> extends OperationCtx {
  /** The definition's store — the durability/query port, as a boundary facet. */
  readonly store: TStore;
}

/**
 * The genesis seam (ADR 93): produce the prompts the session opens with. Runs on
 * CREATE and RESUME, never on FORK / SPAWN-inherit. Runs after identity stamping
 * and before first render — and a rejection FAILS session creation with
 * `PromptsHydrateFailed` (no half-genesis session).
 *
 * The returned records are a SEED: never registered as ops, never written back to
 * the store.
 *
 * Also the source `reload()` and the `invoke()` / `render()` lookup-on-miss
 * re-run — one seam, not two.
 */
export type PromptsHydrator<TStore extends PromptsStore = PromptsStore> = (
  ctx: PromptsHydrateCtx<TStore>,
) => Promise<readonly PromptSeed[]>;

// ============================================================================
// The definition
// ============================================================================

/**
 * The prompts namespace definition — the CLOSED surface (ADR 93 §"Definition
 * surface — complete and closed"): the store, the genesis seam, this namespace's
 * shaping seams, and the two interceptor bags.
 *
 * This same type is what `withPrompts(...)` and `createApp({ prompts })` accept
 * inline — `definePrompts` adds identity + the brand, not a new shape.
 */
export interface PromptsDefinition<TStore extends PromptsStore = PromptsStore> {
  /**
   * Durable backing for the prompt DECLARATION slice — the durability/query port,
   * and the end of the withPrompts-lacks-a-store asymmetry (ADR 93 rendered-moot
   * #4). Defaults to a fresh per-session in-memory `InMemoryPromptStore`.
   *
   * Only the serializable `PromptDeclarationRecord` is stored; `template` /
   * `render` stay in the harness sidecar. A store on its own loads nothing —
   * pair it with `hydrate: hydrateFromStore()`.
   */
  readonly store?: TStore;
  /**
   * The genesis seam. **Default none** — a definition with neither a store read
   * nor a source hydrator opens an empty catalog.
   *
   * Declared as a METHOD signature, not a function-typed property, and
   * deliberately so (ADR 93 landmine 6). `TStore` appears here in a PARAMETER
   * position, so a property declaration would make `PromptsDefinition` invariant
   * under `strictFunctionTypes` — and then `definePrompts({ store: myPgStore,
   * hydrate })` would not fit a slot typed at the PORT, which is every slot.
   * Method params are checked bivariantly, which is the correct trade here: the
   * store a definition names and the store its hydrator receives are the same
   * object by construction.
   */
  hydrate?(ctx: PromptsHydrateCtx<TStore>): Promise<readonly PromptSeed[]>;
  /**
   * Renderers for content shapes the core does not handle natively (`string` and
   * `MessageEntry[]` work with no renderer). First-match-wins on
   * `renderer.handles(content)`. Framework bindings ship their own —
   * `reactPromptRenderer` from `@agentick/prompts-react`.
   */
  readonly renderers?: readonly PromptRenderer[];
  /**
   * Project each prompt as a read-only `prompt://<name>` resource on the
   * session's resources harness. Default `true` — the catalog becomes browsable
   * through the standard resources surface (and the MCP projection). Content is
   * served HONESTLY: a static string `template` as `text/markdown`; a function
   * `render` (or a non-string `template`) as a `{ name, description, arguments }`
   * declaration document — a function is never serialized, a render result never
   * faked. Set `false` to keep prompts off the resources surface.
   */
  readonly exposeAsResources?: boolean;
  /**
   * Namespace-local command hooks (ADR 93) — DROP-LAYER keys
   * (`onBeforeRegister`, not `onBeforePromptsRegister`). Pure colocation sugar:
   * each entry desugars to the same op-scoped interceptor the app-level
   * discriminated bag produces. App-level hooks wrap these.
   */
  readonly hooks?: NamespaceHooks<"prompts">;
  /**
   * Namespace-local guards (ADR 93) — DROP-LAYER keys (`{ invoke }`, not
   * `{ promptsInvoke }`). A distinct KIND from hooks: the verdict seam, floated
   * OUTERMOST of every transform. App-level guards outrank these.
   */
  readonly guards?: NamespaceGuards<"prompts">;
}

/** A {@link PromptsDefinition} carrying the {@link definePrompts} brand. */
export type BrandedPromptsDefinition<TStore extends PromptsStore = PromptsStore> =
  PromptsDefinition<TStore> & { readonly [PROMPTS_DEFINITION]: true };

/**
 * Name a prompts definition (ADR 93). Identity + brand — it returns `options`
 * with the definition brand stamped; nothing is constructed, no store is opened,
 * no hydrator runs.
 *
 * ```ts
 * export default definePrompts({
 *   store: postgresPromptStore({ executor: pool }),
 *   hydrate: hydrateFromModule({ specifier: "./prompts/index.js" }),
 *   renderers: [reactPromptRenderer],
 *   guards: { invoke: (input) => (isBlocked(input.name) ? { kind: "veto" } : undefined) },
 * });
 * ```
 */
export function definePrompts<TStore extends PromptsStore = PromptsStore>(
  options: PromptsDefinition<TStore> = {},
): BrandedPromptsDefinition<TStore> {
  return Object.defineProperty(options, PROMPTS_DEFINITION, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  }) as BrandedPromptsDefinition<TStore>;
}

/**
 * Does `value` carry the {@link definePrompts} brand? Note that an INLINE bag
 * (`withPrompts({ store })`) is a perfectly valid definition and is NOT branded —
 * so slots discriminate a definition from a LIVE HARNESS with spec's
 * `isPromptsInstance`, and use this only when the brand itself is the question.
 */
export function isPromptsDefinition(value: unknown): value is BrandedPromptsDefinition {
  return typeof value === "object" && value !== null && PROMPTS_DEFINITION in value;
}

/**
 * What `withPrompts` / the `prompts` slot accept — the ADR-42 dichotomy, no third
 * form: a DEFINITION (declarative, inert until install, constructed per-session)
 * or a LIVE INSTANCE (the adopter owns its lifecycle).
 */
export type PromptsConfig = PromptsDefinition | Prompts;
