/**
 * `defineCompletions` — the completions NAMESPACE DEFINITION (ADR 93).
 *
 * An options bag like every other namespace definition, with ONE seam today:
 * `sources`, the registry contents. There is deliberately no `store` — a
 * resolver is a function and does not serialize, so completions has no
 * durability port and no genesis hydrator; content arrives from code, inline or
 * through a barrel of {@link defineCompletion} files.
 *
 * ```ts
 * export default defineCompletions({
 *   sources: {
 *     "knowify.jobs": completeFromAsync((value, ctx) => jobsApi.search(value, ctx)),
 *     "knowify.phases": completeDependent({ requires: ["job"] }, (v, { job }) =>
 *       phasesApi.search(v, job)),
 *   },
 * });
 * // …or the barrel form: defineCompletions({ sources: [jobs, phases] })
 * ```
 *
 * A declaration then references a source by NAME — a string crosses the spec
 * firewall the way `handlerRef` does; a function never does.
 *
 * `defineCompletions` is **identity + brand**: it returns its options, stamped.
 * Nothing is constructed and no resolver runs — definitions are INERT until
 * install, where the harness is built per-session and the sources registered.
 * A source attaches to a harness instance ONLY by being listed here (or by
 * being embedded in a declaration that carries it); nothing self-registers at
 * import time — an ambient registry would have no answer to "which session?".
 *
 * @see docs/proposals/v2/completions.md §2.2
 * @see docs/proposals/v2/blueprint/93-namespace-definitions.md
 * @verifiedBy packages/completions/src/__tests__/harness.spec.ts
 */

import type { Completions, CompletionResolver } from "@agentick/spec";

import { isDependentResolver } from "./builders.js";

/**
 * A {@link CompletionResolver} carrying its canonical registry name — what
 * {@link defineCompletion} returns. Still a plain resolver (dual-use: list it in
 * `defineCompletions([...])` OR hand it straight to a prompt argument's
 * `complete:` slot), with the name readable off the function the same way
 * `completeDependent`'s `requires` is.
 */
export type NamedCompletionResolver = CompletionResolver & {
  /** The canonical name this source registers under. */
  readonly completionName: string;
};

/**
 * Name a single completion source — the SINGULAR of the file grammar: one
 * source per file, default-exported, collected by an explicit barrel into
 * `defineCompletions([...])`. (`definePrompts`/`definePrompt` follow the same
 * plural/singular rule.)
 *
 * Returns a fresh forwarding resolver rather than mutating `resolver`, so one
 * underlying resolver may be named twice and a builder's own metadata
 * (`requires`) is carried over, not lost.
 */
export function defineCompletion(
  name: string,
  resolver: CompletionResolver,
): NamedCompletionResolver {
  const named: CompletionResolver = (value, ctx) => resolver(value, ctx);
  if (isDependentResolver(resolver)) {
    Object.defineProperty(named, "requires", {
      value: resolver.requires,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return Object.defineProperty(named, "completionName", {
    value: name,
    enumerable: false,
    configurable: false,
    writable: false,
  }) as NamedCompletionResolver;
}

/** Does this resolver carry a canonical name from {@link defineCompletion}? */
export function isNamedCompletionResolver(
  resolver: CompletionResolver,
): resolver is NamedCompletionResolver {
  return typeof (resolver as Partial<NamedCompletionResolver>).completionName === "string";
}

/**
 * The brand `defineCompletions` stamps. Symbol-keyed and non-enumerable so it
 * never collides with a completion name and stays out of `JSON.stringify` /
 * spread-visible shape.
 */
const COMPLETIONS_DEFINITION: unique symbol = Symbol("agentick.completionsDefinition");

/**
 * What the `sources` seam accepts: the terse inline map, or a barrel of
 * {@link defineCompletion} files (each source carrying its own name).
 */
export type CompletionSources =
  | Readonly<Record<string, CompletionResolver>>
  | readonly NamedCompletionResolver[];

/**
 * The completions namespace definition — the options bag `defineCompletions`
 * stamps and `withCompletions` / the `completions` slot accept inline.
 */
export interface CompletionsDefinition {
  /** The registry contents this session opens with. Default none. */
  readonly sources?: CompletionSources;
}

/** A {@link CompletionsDefinition} carrying the {@link defineCompletions} brand. */
export type BrandedCompletionsDefinition = CompletionsDefinition & {
  readonly [COMPLETIONS_DEFINITION]: true;
};

/**
 * Name a completions definition (ADR 93). Identity + brand — nothing runs and
 * nothing is constructed; definitions are inert until install. A duplicate name
 * in the ARRAY form of `sources` throws at define time (rather than silently
 * last-wins at install), which is why the fold runs here.
 */
export function defineCompletions(
  options: CompletionsDefinition = {},
): BrandedCompletionsDefinition {
  if (options.sources !== undefined) sourcesMapOf(options.sources); // fail duplicates early
  return Object.defineProperty(options, COMPLETIONS_DEFINITION, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  }) as BrandedCompletionsDefinition;
}

/**
 * Fold a {@link CompletionSources} into the flat `name → resolver` map the
 * harness registers — the install-time normalizer. Refuses duplicate names in
 * the array form.
 */
export function sourcesMapOf(
  sources: CompletionSources,
): Readonly<Record<string, CompletionResolver>> {
  if (!Array.isArray(sources)) return sources as Readonly<Record<string, CompletionResolver>>;
  const map: Record<string, CompletionResolver> = {};
  for (const source of sources as readonly NamedCompletionResolver[]) {
    if (map[source.completionName] !== undefined) {
      throw new Error(`defineCompletions: duplicate completion name "${source.completionName}"`);
    }
    map[source.completionName] = source;
  }
  return map;
}

/**
 * Does `value` carry the {@link defineCompletions} brand? Note that an INLINE map
 * (`withCompletions({ "a.b": resolver })`) is a perfectly valid definition and is
 * NOT branded — so the slot discriminates a definition from a LIVE HARNESS with
 * spec's `isCompletionsInstance`, and uses this only when the brand itself is the
 * question.
 */
export function isCompletionsDefinition(value: unknown): value is BrandedCompletionsDefinition {
  return typeof value === "object" && value !== null && COMPLETIONS_DEFINITION in value;
}

/**
 * What `withCompletions` / the `completions` slot accept — the ADR-42 dichotomy,
 * no third form: a DEFINITION MAP (declarative, inert until install, constructed
 * per-session) or a LIVE INSTANCE (the adopter owns its lifecycle).
 */
export type CompletionsConfig = CompletionsDefinition | Completions;
