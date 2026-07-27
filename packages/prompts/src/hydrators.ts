/**
 * Named hydrators — the prompts genesis-seam library (ADR 93 D3).
 *
 * A hydrator is a plain function of the derived ctx returning the prompts the
 * session opens with. The public surface is **deliberately narrower** than skills'
 * because prompts have a function-carrying subset (`render(args, ctx)`), and not
 * every transport can carry a function:
 *
 *  - {@link hydrateFrom} — literal records; `render` functions survive (same module)
 *  - {@link hydrateFromModule} — dynamic import; the ONE source that carries
 *    functions across a load boundary
 *  - {@link hydrateFromStaticUrl} — a JSON manifest, constrained to TEMPLATE-ONLY
 *    prompts; a loaded record naming a `render` field raises
 *  - {@link hydrateFromStore} — the durable declaration slice (record-only: the
 *    `{ template, render }` sidecar does not survive a store round-trip)
 *  - {@link composeHydrators} — several sources at once
 *
 * No filesystem hydrator here: JSX `.tsx` files on disk need a bundler /
 * transform pipeline, which is not a primitive concern. Framework bindings supply
 * their own.
 *
 * **The seed law.** What a hydrator returns is a SEED — it is adopted into the
 * read view without a `prompts:register` op and without a store write. Writing
 * genesis back would duplicate the catalog on every resume.
 *
 * @see docs/proposals/v2/blueprint/93-namespace-definitions.md
 * @see ./definition.ts — the definition the hydrator hangs off
 * @verifiedBy packages/prompts/src/__tests__/hydrators.spec.ts
 */

import type { PromptDeclaration, PromptsRegisterInput } from "@agentick/spec";
import {
  type FromModuleOptions as FromModuleOptionsPrimitive,
  mapLoader,
  sourceFromModule,
  sourceFromUrl,
} from "@agentick/utils/loaders";

import type { PromptSeed, PromptsHydrator, PromptsStore } from "./definition.js";

/**
 * Open on the literal records supplied here — the inline / bundled-catalog source,
 * and the replacement for the deleted `initial:` option. Each entry MAY carry a
 * `render` function: they survive because the array lives in the same JS module.
 *
 * The array is captured by reference and re-read on every `reload()`, so mutating
 * it after construction is visible.
 */
export function hydrateFrom<TStore extends PromptsStore = PromptsStore>(
  records: readonly PromptSeed[],
): PromptsHydrator<TStore> {
  return async () => records;
}

/**
 * Open on the durable store's declaration catalog — the store-read hydrator, and
 * the capability the withPrompts-lacks-a-store asymmetry withheld (ADR 93
 * rendered-moot #4).
 *
 * NOT a default: configuring a `store` loads nothing until you ask for it.
 *
 * **What survives.** Only the serializable `PromptDeclarationRecord`. A prompt
 * whose content was a `render` function or a non-string `template` comes back
 * CONTENT-LESS, because a function cannot be stored. Pair this with
 * {@link hydrateFromModule} (via {@link composeHydrators}) when the catalog is
 * durable but the content is code: the store supplies the declaration set, the
 * module supplies the functions, and last-wins puts the code on top.
 */
export function hydrateFromStore<
  TStore extends PromptsStore = PromptsStore,
>(): PromptsHydrator<TStore> {
  return async (ctx) => {
    const records = await ctx.store.query(undefined, ctx);
    return records.map((declaration) => ({ declaration }) as PromptSeed);
  };
}

export interface HydrateFromModuleOptions {
  readonly specifier: string;
  /**
   * Pick the prompt(s) out of the imported module. Default picks `module.default`
   * when it is a `PromptsRegisterInput` (or an array thereof), else picks
   * `module.prompts`. Override for custom export conventions.
   */
  readonly picker?: FromModuleOptionsPrimitive<PromptsRegisterInput>["picker"];
  /** Dynamic-import override — useful for bundler-specific resolution. */
  readonly import?: (specifier: string) => Promise<unknown>;
}

/**
 * Open on a dynamically imported module — the one source that preserves
 * `render(args, ctx)` functions across the load boundary, and therefore the
 * source a code-authored prompt catalog uses.
 *
 * The import happens on every genesis and every `reload()`; the host's module
 * cache makes repeat imports cheap.
 */
export function hydrateFromModule<TStore extends PromptsStore = PromptsStore>(
  options: HydrateFromModuleOptions,
): PromptsHydrator<TStore> {
  const source = sourceFromModule<PromptsRegisterInput>({
    specifier: options.specifier,
    picker: options.picker ?? defaultPicker,
    ...(options.import ? { import: options.import } : {}),
  });
  return () => source.load();
}

function defaultPicker(mod: unknown): readonly PromptsRegisterInput[] {
  if (mod == null || typeof mod !== "object") return [];
  const m = mod as Record<string, unknown>;
  // Convention 1: a default-exported array OR single record
  if (m.default !== undefined) {
    return Array.isArray(m.default)
      ? (m.default as readonly PromptsRegisterInput[])
      : [m.default as PromptsRegisterInput];
  }
  // Convention 2: named export `prompts: PromptsRegisterInput[]`
  if (Array.isArray(m.prompts)) {
    return m.prompts as readonly PromptsRegisterInput[];
  }
  return [];
}

export interface HydrateFromStaticUrlOptions {
  readonly url: string | URL;
  readonly fetch?: typeof fetch;
  readonly init?: RequestInit;
  readonly acceptStatuses?: readonly number[];
  /**
   * Field on the JSON body carrying the prompt array. Default `"prompts"`. Pass
   * `null` to treat the whole body as the array.
   */
  readonly arrayField?: string | null;
}

/**
 * Open on a JSON manifest of **template-only** prompts. The constraint is
 * enforced at load: a returned prompt naming a `render` field rejects, because a
 * function cannot survive a URL round-trip and silently dropping it would produce
 * a prompt that renders nothing. Adopters who need dynamic prompts use
 * {@link hydrateFromModule} or {@link hydrateFrom}.
 *
 * The response body must be either `{ "prompts": PromptsRegisterInput[] }`
 * (default) or a top-level array (`arrayField: null`).
 */
export function hydrateFromStaticUrl<TStore extends PromptsStore = PromptsStore>(
  options: HydrateFromStaticUrlOptions,
): PromptsHydrator<TStore> {
  const field = options.arrayField === undefined ? "prompts" : options.arrayField;
  const inner = sourceFromUrl<PromptsRegisterInput>({
    url: options.url,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.init ? { init: options.init } : {}),
    ...(options.acceptStatuses ? { acceptStatuses: options.acceptStatuses } : {}),
    parse: async (response) => {
      const body = (await response.json()) as unknown;
      if (field === null) {
        if (!Array.isArray(body)) {
          throw new Error(`hydrateFromStaticUrl: ${String(options.url)} did not yield an array`);
        }
        return body as readonly PromptsRegisterInput[];
      }
      if (body == null || typeof body !== "object" || !(field in body)) {
        throw new Error(
          `hydrateFromStaticUrl: ${String(options.url)} response missing "${field}" field`,
        );
      }
      const arr = (body as Record<string, unknown>)[field];
      if (!Array.isArray(arr)) {
        throw new Error(
          `hydrateFromStaticUrl: ${String(options.url)} "${field}" field is not an array`,
        );
      }
      return arr as readonly PromptsRegisterInput[];
    },
  });
  const validated = mapLoader(inner, (input) => {
    const decl = input.declaration as PromptDeclaration;
    if (decl == null || typeof decl !== "object") {
      throw new Error(
        `hydrateFromStaticUrl: ${String(options.url)} entry missing "declaration" field`,
      );
    }
    if ("render" in decl && decl.render !== undefined) {
      throw new Error(
        `hydrateFromStaticUrl: ${String(options.url)} prompt "${decl.name}" carries a render function — URL-loaded prompts must be template-only`,
      );
    }
    return input;
  });
  return () => validated.load();
}

/**
 * Run several hydrators and concatenate their records — the multi-source form, and
 * the replacement for the deleted `loaders: []` array.
 *
 * Hydrators run CONCURRENTLY; the result follows INPUT order, not completion
 * order. On a duplicate prompt name the LAST source wins, so ordering is the
 * override ladder — `composeHydrators(hydrateFromStore(), hydrateFromModule({…}))`
 * lets code-authored content shadow the durable declaration slice, which is how a
 * durable catalog of function-backed prompts is assembled.
 *
 * Deliberately not partial-success: one rejecting source rejects the whole
 * genesis (and so fails session creation).
 */
export function composeHydrators<TStore extends PromptsStore = PromptsStore>(
  ...hydrators: readonly PromptsHydrator<TStore>[]
): PromptsHydrator<TStore> {
  return async (ctx) => {
    const batches = await Promise.all(hydrators.map((h) => h(ctx)));
    // Last-writer-wins on the declaration name, insertion order preserved by Map.
    const merged = new Map<string, PromptSeed>();
    for (const batch of batches) {
      for (const record of batch) merged.set(record.declaration.name, record);
    }
    return [...merged.values()];
  };
}

// TODO(D-phase): the client READ door for prompts — `prompts:list` / `prompts:get`
// are already `exposure: "wire"` declared commands, but per the
// enumeration-is-foundational rule the client face also needs `added` / `removed`
// topology notifications. That is a wire + client-* concern, so it attaches at
// `./wire-augment.ts` and `./client/`, not here.
