/**
 * `PromptLoader` — `Loader<PromptsRegisterInput>` factories.
 *
 * Public surface is **deliberately narrower** than the skills loaders:
 *
 *  - `fromArray(prompts)` — literal records; functions survive
 *  - `fromModule({ specifier, picker })` — dynamic import; functions
 *    survive
 *  - `fromStaticUrl(url, ...)` — fetch a JSON manifest, but the
 *    returned records are constrained to **template-only** prompts.
 *    A loaded prompt that names a `render` field raises a load error.
 *
 * No `fromFile` / `fromDirectory` here — JSX `.tsx` files on disk need
 * a bundler / transform pipeline, which isn't a primitive concern.
 * Framework bindings can supply their own filesystem factories
 * (e.g., `@agentick/prompts-react-next/loaders/node`).
 *
 * @see docs/proposals/v2/blueprint/32-extension-shape-spectrum.md
 */

import type { PromptDeclaration, PromptsRegisterInput } from "@agentick/spec-next";
import {
  type FromModuleOptions as FromModuleOptionsPrimitive,
  type Loader,
  mapLoader,
  sourceFromArray,
  sourceFromModule,
  sourceFromUrl,
} from "@agentick/utils-next/loaders";

export type PromptLoader = Loader<PromptsRegisterInput>;

/**
 * Wrap an in-memory array as a `PromptLoader`. Use for bundled
 * starter prompts. Each entry MAY carry a `render` function — they
 * survive because the array lives in the same JS module.
 */
export function fromArray(prompts: readonly PromptsRegisterInput[]): PromptLoader {
  const base = sourceFromArray(prompts);
  return {
    load: base.load,
    lookup: async (name) => prompts.find((p) => p.declaration.name === name) ?? null,
  };
}

export interface FromModuleOptions {
  readonly specifier: string;
  /**
   * Pick the prompt(s) out of the imported module. Default picks
   * `module.default` when it's a `PromptsRegisterInput` (or an array
   * thereof), else picks `module.prompts`. Override for custom export
   * conventions.
   */
  readonly picker?: FromModuleOptionsPrimitive<PromptsRegisterInput>["picker"];
  /** Dynamic-import override — useful for bundler-specific resolution. */
  readonly import?: (specifier: string) => Promise<unknown>;
}

/**
 * Dynamic-import a module and pick prompts out of its exports. The
 * one source that preserves `render(args)` functions across the load
 * boundary.
 */
export function fromModule(options: FromModuleOptions): PromptLoader {
  const picker = options.picker ?? defaultPicker;
  const inner = sourceFromModule<PromptsRegisterInput>({
    specifier: options.specifier,
    picker,
    ...(options.import ? { import: options.import } : {}),
  });
  return {
    load: inner.load,
    lookup: async (name) => {
      const all = await inner.load();
      return all.find((p) => p.declaration.name === name) ?? null;
    },
  };
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

export interface FromStaticUrlOptions {
  readonly url: string | URL;
  readonly fetch?: typeof fetch;
  readonly init?: RequestInit;
  readonly acceptStatuses?: readonly number[];
  /**
   * Field on the JSON body that carries the prompt array. Default
   * `"prompts"`. Pass `null` to treat the entire body as the array.
   */
  readonly arrayField?: string | null;
}

/**
 * Fetch a JSON manifest of **template-only** prompts. The constraint
 * is enforced at load time: if any returned prompt names a `render`
 * field, the load fails — functions cannot survive a URL round-trip.
 * Adopters who need dynamic prompts must use `fromModule` or
 * `fromArray`.
 *
 * The response body must be either:
 *  - `{ "prompts": PromptsRegisterInput[] }` (default), OR
 *  - a top-level `PromptsRegisterInput[]` (set `arrayField: null`).
 */
export function fromStaticUrl(options: FromStaticUrlOptions): PromptLoader {
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
          throw new Error(`prompts.fromStaticUrl: ${String(options.url)} did not yield an array`);
        }
        return body as readonly PromptsRegisterInput[];
      }
      if (body == null || typeof body !== "object" || !(field in body)) {
        throw new Error(
          `prompts.fromStaticUrl: ${String(options.url)} response missing "${field}" field`,
        );
      }
      const arr = (body as Record<string, unknown>)[field];
      if (!Array.isArray(arr)) {
        throw new Error(
          `prompts.fromStaticUrl: ${String(options.url)} "${field}" field is not an array`,
        );
      }
      return arr as readonly PromptsRegisterInput[];
    },
  });
  const validated = mapLoader(inner, (input) => {
    const decl = input.declaration as PromptDeclaration;
    if (decl == null || typeof decl !== "object") {
      throw new Error(
        `prompts.fromStaticUrl: ${String(options.url)} entry missing "declaration" field`,
      );
    }
    if ("render" in decl && decl.render !== undefined) {
      throw new Error(
        `prompts.fromStaticUrl: ${String(options.url)} prompt "${decl.name}" carries a render function — URL-loaded prompts must be template-only`,
      );
    }
    return input;
  });
  return {
    load: validated.load,
    lookup: async (name) => {
      const all = await validated.load();
      return all.find((p) => p.declaration.name === name) ?? null;
    },
  };
}
