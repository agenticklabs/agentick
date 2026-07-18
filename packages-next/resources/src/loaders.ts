/**
 * `ResourceLoader` — `Loader<ResourceLoaderItem>` factories (data-layer plan
 * Phase 5 run #9). The **durable source resources lacks today**: a read-only
 * source (array / module / DB / fs) that FEEDS the store with declarations and
 * the harness sidecar with resolvers.
 *
 * A loaded item carries BOTH halves of the split — the serializable
 * {@link import("@agentick/spec-next").ResourceDeclarationRecord} (→ the store) AND the
 * live `resolver` fn (→ the sidecar), exactly as a prompt loader item carries
 * `render` alongside its record. Because a resource is USELESS without its
 * resolver (the resolver IS how content is read), the surface is deliberately
 * narrower than prompts':
 *
 *  - `fromArray(items)`  — literal items; resolver fns survive (same JS module).
 *  - `fromModule({ … })` — dynamic import; the one source that preserves the
 *    resolver fn across the load boundary.
 *
 * There is deliberately **no `fromStaticUrl`**: a URL/JSON source cannot carry a
 * resolver fn, and a resolver-less resource can never be `read()`. Adopters
 * wanting URL-sourced content register a resolver that fetches on demand
 * (`register("proxy://…", () => fetch(…))`) — the resolver, not the source, is
 * where the network lives.
 *
 * @see docs/proposals/v2/data-layer-plan.md §6-C
 * @see packages-next/prompts/src/loaders.ts
 */

import type { ResourceDeclarationRecord, ResourceResolver } from "@agentick/spec-next";
import { resourceDeclarationKey } from "@agentick/spec-next";
import {
  type FromModuleOptions as FromModuleOptionsPrimitive,
  type Loader,
  sourceFromArray,
  sourceFromModule,
} from "@agentick/utils-next/loaders";

/**
 * One durable-source resource: the serializable declaration (→ store) plus the
 * live resolver (→ sidecar). Both a fixed `ResourceResolver` and a
 * `TemplateResolver` have the identical `(uri) => contents` signature, so
 * `ResourceResolver` types both — the declaration's `kind` says which it is.
 */
export interface ResourceLoaderItem {
  readonly declaration: ResourceDeclarationRecord;
  readonly resolver: ResourceResolver;
}

export type ResourceLoader = Loader<ResourceLoaderItem>;

/**
 * Wrap an in-memory array as a `ResourceLoader`. Use for bundled starter
 * resources. Each item's `resolver` survives — the array lives in the same JS
 * module.
 */
export function fromArray(items: readonly ResourceLoaderItem[]): ResourceLoader {
  const base = sourceFromArray(items);
  return {
    load: base.load,
    lookup: async (key) => items.find((i) => resourceDeclarationKey(i.declaration) === key) ?? null,
  };
}

export interface FromModuleOptions {
  readonly specifier: string;
  /**
   * Pick the resource item(s) out of the imported module. Default picks
   * `module.default` when it's a `ResourceLoaderItem` (or an array thereof),
   * else picks `module.resources`. Override for custom export conventions.
   */
  readonly picker?: FromModuleOptionsPrimitive<ResourceLoaderItem>["picker"];
  /** Dynamic-import override — useful for bundler-specific resolution. */
  readonly import?: (specifier: string) => Promise<unknown>;
}

/**
 * Dynamic-import a module and pick resource items out of its exports. The one
 * source that preserves the `resolver(uri)` fn across the load boundary.
 */
export function fromModule(options: FromModuleOptions): ResourceLoader {
  const picker = options.picker ?? defaultPicker;
  const inner = sourceFromModule<ResourceLoaderItem>({
    specifier: options.specifier,
    picker,
    ...(options.import ? { import: options.import } : {}),
  });
  return {
    load: inner.load,
    lookup: async (key) => {
      const all = await inner.load();
      return all.find((i) => resourceDeclarationKey(i.declaration) === key) ?? null;
    },
  };
}

function defaultPicker(mod: unknown): readonly ResourceLoaderItem[] {
  if (mod == null || typeof mod !== "object") return [];
  const m = mod as Record<string, unknown>;
  // Convention 1: a default-exported array OR single item.
  if (m.default !== undefined) {
    return Array.isArray(m.default)
      ? (m.default as readonly ResourceLoaderItem[])
      : [m.default as ResourceLoaderItem];
  }
  // Convention 2: named export `resources: ResourceLoaderItem[]`.
  if (Array.isArray(m.resources)) {
    return m.resources as readonly ResourceLoaderItem[];
  }
  return [];
}
