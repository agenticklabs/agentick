/**
 * Named hydrators — the skills genesis-seam library (ADR 93 D3).
 *
 * A hydrator is a plain function of the derived ctx returning the skills the
 * session opens with. These are the universal ones (no `node:*`); the
 * filesystem sources live at `@agentick/skills/hydrators/node` because
 * `node:fs` is Node-only.
 *
 * ## Sources are hydrators
 *
 * This file IS the source unification (ADR 93 rendered-moot #3). Skills used to
 * carry a parallel source-config vocabulary — `initial:` for literal records
 * PLUS `loaders:` for an array of `SkillLoader`s, each with its own `load()` /
 * `lookup()` contract. There is now one seam. A literal array is
 * {@link hydrateFrom}; a JSON manifest is {@link hydrateFromUrl}; the durable
 * store is {@link hydrateFromStore}; a directory is `hydrateFromDirectory`
 * (the `/node` subpath); several at once is {@link composeHydrators}. Anything
 * with the `SkillsHydrator` shape works, which is the point — a tiered catalog
 * is a hydrator reading `ctx.principal`, an event-sourced catalog is a hydrator
 * folding `ctx.journalReader`.
 *
 * **The seed law.** What a hydrator returns is a SEED — it is adopted into the
 * read view without a `skills:register` op and without a store write.
 * `hydrateFromStore` reads what is already durable; a directory hydrator reads
 * files the adopter deliberately keeps as the source of truth. Writing genesis
 * back would duplicate the catalog on every resume (the #1 footgun — asserted in
 * `genesis.spec.ts`).
 *
 * Lives at the package root (not a `/hydrators` subpath for the universal set)
 * because a hydrator is part of the definition surface, not an optional extras
 * bag: `defineSkills({ hydrate: hydrateFromStore() })` is the common case.
 *
 * @see docs/proposals/v2/blueprint/93-namespace-definitions.md
 * @see ./definition.ts — the definition the hydrator hangs off
 * @verifiedBy packages/skills/src/__tests__/hydrators.spec.ts
 */

import { sourceFromUrl } from "@agentick/utils/loaders";

import type { SkillSeed, SkillsHydrator, SkillsStore } from "./definition.js";

/**
 * Open on the literal records supplied here — the inline / bundled-catalog
 * source, and the replacement for the deleted `initial:` option.
 *
 * ```ts
 * defineSkills({ hydrate: hydrateFrom([{ name: "triage", description: "…", content: "…" }]) })
 * ```
 *
 * The array is captured by reference and re-read on every `reload()`, so mutating
 * it after construction is visible — deliberately: it makes an adopter-owned
 * array a live source without a second mechanism.
 */
export function hydrateFrom<TStore extends SkillsStore = SkillsStore>(
  records: readonly SkillSeed[],
): SkillsHydrator<TStore> {
  return async () => records;
}

/**
 * Open on the durable store's whole catalog — the store-read hydrator.
 *
 * NOT a default (unlike the timeline's): configuring a `store` on a skills
 * definition loads nothing until you ask for it. Which slice of a catalog a
 * session should open with is a policy question with no safe default; this is the
 * answer for "all of it".
 *
 * The seed law applies with force here: the records came FROM the store, so
 * re-persisting them would be a pointless write-back.
 */
export function hydrateFromStore<
  TStore extends SkillsStore = SkillsStore,
>(): SkillsHydrator<TStore> {
  return (ctx) => ctx.store.query(undefined, ctx);
}

export interface HydrateFromUrlOptions {
  readonly url: string | URL;
  /** Override the global `fetch` (tests, custom dispatchers). */
  readonly fetch?: typeof fetch;
  readonly init?: RequestInit;
  /** Statuses to accept as success. Default: `response.ok`. */
  readonly acceptStatuses?: readonly number[];
  /**
   * Field on the JSON body carrying the skill array. Default `"skills"`. Pass
   * `null` to treat the whole body as the array.
   */
  readonly arrayField?: string | null;
}

/**
 * Open on a JSON manifest fetched at session-open. The response body must be
 * either `{ "skills": SkillsRegisterInput[] }` (default) or a top-level array
 * (`arrayField: null`).
 *
 * No schema validation — wrap the hydrator if you need it. Skill records are
 * entirely string-based (`name`, `description`, `content`), so a URL round-trip
 * is sound for every field; unlike prompts, skills have no function-carrying
 * subset.
 *
 * The fetch happens on every genesis AND every `reload()`. A failure rejects, so
 * an unreachable manifest FAILS session creation with `SkillsHydrateFailed` —
 * compose with a fallback (`composeHydrators`) or catch inside your own hydrator
 * if degraded start is what you want.
 */
export function hydrateFromUrl<TStore extends SkillsStore = SkillsStore>(
  options: HydrateFromUrlOptions,
): SkillsHydrator<TStore> {
  const field = options.arrayField === undefined ? "skills" : options.arrayField;
  const source = sourceFromUrl<SkillSeed>({
    url: options.url,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.init ? { init: options.init } : {}),
    ...(options.acceptStatuses ? { acceptStatuses: options.acceptStatuses } : {}),
    parse: async (response) => {
      const body = (await response.json()) as unknown;
      if (field === null) {
        if (!Array.isArray(body)) {
          throw new Error(`hydrateFromUrl: ${String(options.url)} did not yield an array`);
        }
        return body as readonly SkillSeed[];
      }
      if (body == null || typeof body !== "object" || !(field in body)) {
        throw new Error(`hydrateFromUrl: ${String(options.url)} response missing "${field}" field`);
      }
      const arr = (body as Record<string, unknown>)[field];
      if (!Array.isArray(arr)) {
        throw new Error(`hydrateFromUrl: ${String(options.url)} "${field}" field is not an array`);
      }
      return arr as readonly SkillSeed[];
    },
  });
  return () => source.load();
}

/**
 * Alias of {@link hydrateFromUrl} — same shape, named to read better at the call
 * site when the URL is an explicit "skills manifest" endpoint.
 */
export const hydrateFromManifest = hydrateFromUrl;

/**
 * Run several hydrators and concatenate their records — the multi-source form,
 * and the replacement for the deleted `loaders: []` array.
 *
 * Hydrators run CONCURRENTLY; the result follows INPUT order, not completion
 * order. On a duplicate `name` the LAST source wins, so ordering is the override
 * ladder: `composeHydrators(hydrateFromStore(), hydrateFromDirectory({ path }))`
 * lets the working tree shadow the durable catalog.
 *
 * Deliberately not partial-success: one rejecting source rejects the whole
 * genesis (and so fails session creation). Wrap a source in your own hydrator if
 * you want it to degrade to `[]`.
 */
export function composeHydrators<TStore extends SkillsStore = SkillsStore>(
  ...hydrators: readonly SkillsHydrator<TStore>[]
): SkillsHydrator<TStore> {
  return async (ctx) => {
    const batches = await Promise.all(hydrators.map((h) => h(ctx)));
    // Last-writer-wins on `name`, insertion order preserved by Map.
    const merged = new Map<string, SkillSeed>();
    for (const batch of batches) {
      for (const record of batch) merged.set(record.name, record);
    }
    return [...merged.values()];
  };
}

// TODO(D-phase): the client READ door for skills — `skills:list` / `skills:get`
// / `skills:search` are already `exposure: "wire"` declared commands, but per the
// enumeration-is-foundational rule the client face also needs `added` / `removed`
// topology notifications so a client can maintain a live catalog without
// re-listing. That is a wire + client-* concern (grant recipe at the gateway,
// consuming face in the client SDK), so it attaches at `./wire-augment.ts` and
// `./client/`, not here.
