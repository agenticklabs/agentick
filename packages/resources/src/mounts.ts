/**
 * Mounting a keyed store as a browsable resource tree.
 *
 * Three composable functions over the resolver primitive the harness already
 * has — none is a harness method:
 *
 *   - `storeResolver(store, projection?)` — a `{ get, listChildren }` store → a
 *     resolver, with the projection as the ONE outbound address boundary.
 *   - `mount(resolver, meta?)` — a resolver + its workspace description.
 *   - `createTree(tree)` — many mounts → one resolver, routed by longest prefix.
 *
 * `MountStore` is content-shaped (its `get` returns rendered `ResourceContents`)
 * and browsable (`listChildren`) — distinct from spec's `ResourceStore`, the
 * durable declaration-record port.
 *
 * The projection rewrites ADDRESSES, never content: a leaf body that names an
 * internal id is the store's to scrub, not this seam's.
 *
 * @see packages/resources/README.md §Mounting stores as a resource tree
 */

import { ResourceNotFound } from "@agentick/spec";
import type {
  OperationCtx,
  ResourceContents,
  ResourceMeta,
  ResourceResolver,
  Resources,
  Unsubscribe,
} from "@agentick/spec";

export interface MountStore {
  get(key: string, ctx?: OperationCtx): Promise<readonly ResourceContents[] | undefined>;
  listChildren(query: MountListQuery, ctx?: OperationCtx): Promise<Page<Child>>;
}

export interface MountListQuery {
  readonly prefix: string;
  /** The `cursor` from the previous page. */
  readonly cursor?: string;
  /** Page size; omitted takes the store's own default. */
  readonly limit?: number;
}

export interface Child {
  readonly name: string;
  readonly kind: "directory" | "leaf";
  /** `name` is the path segment, and an alias is a registry concern. */
  readonly meta?: Omit<ResourceMeta, "name" | "aliases">;
}

export interface Page<T> {
  readonly entries: readonly T[];
  /**
   * Model-facing: it is embedded verbatim in the listing's `nextPage` address,
   * so it must carry no isolation id. The relative child name is the canonical
   * choice — a store keying its cursor on an internal record id leaks it.
   */
  readonly cursor?: string;
}

export interface MountProjection {
  toInternal(homePath: string): string;
  toHome(internalKey: string): string | undefined;
}

export interface Mount {
  readonly resolver: ResourceResolver;
  readonly meta?: ResourceMeta;
}

export type MountTree = Record<string, Mount>;

export type MountTreeSource = MountTree | ((ctx?: OperationCtx) => MountTree | Promise<MountTree>);

export interface MountOptions {
  /** Page size requested of `listChildren`; omitted takes the store's default. */
  readonly limit?: number;
}

const CURSOR = "?cursor=";

function splitUri(uri: string): { scheme: string; path: string } {
  const at = uri.indexOf("://");
  return at < 0
    ? { scheme: "", path: uri }
    : { scheme: uri.slice(0, at + 3), path: uri.slice(at + 3) };
}

function takeCursor(path: string): { path: string; cursor?: string } {
  const q = path.indexOf(CURSOR);
  return q < 0
    ? { path }
    : { path: path.slice(0, q), cursor: decodeURIComponent(path.slice(q + CURSOR.length)) };
}

function joinKey(prefix: string, name: string): string {
  return prefix === "" ? name : `${prefix}/${name}`;
}

/**
 * A path is addressable only in canonical form, so `toHome`'s round-trip cannot
 * be fooled by a traversal a normalizing store would collapse (`a/../b`).
 */
function canonicalHome(path: string): string | undefined {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  if (trimmed === "") return "";
  const traversal = trimmed.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
  return traversal ? undefined : trimmed;
}

export function storeResolver(
  store: MountStore,
  projection?: MountProjection,
  options?: MountOptions,
): ResourceResolver {
  const toInternal = (home: string) => (projection ? projection.toInternal(home) : home);
  const toHome = (key: string): string | undefined => (projection ? projection.toHome(key) : key);
  return async (uri, ctx) => {
    const { scheme, path: raw } = splitUri(uri);
    const { path: requested, cursor } = takeCursor(raw);
    const path = canonicalHome(requested);
    if (path === undefined) throw new ResourceNotFound({ uri });
    const internal = toInternal(path);
    const home = toHome(internal);
    if (home === undefined) throw new ResourceNotFound({ uri });
    const content = await store.get(internal, ctx);
    if (content !== undefined) {
      const address = scheme + home;
      return content.map((c) => ({ ...c, uri: address }));
    }
    // No directory rows: a prefix with no children reads the same as one that
    // was never there. Telling them apart needs a tri-state `listChildren`.
    const page = await store.listChildren({ prefix: internal, cursor, limit: options?.limit }, ctx);
    return [directoryListing(scheme, home, internal, page, toHome)];
  };
}

function directoryListing(
  scheme: string,
  homePath: string,
  internalPrefix: string,
  page: Page<Child>,
  toHome: (key: string) => string | undefined,
): ResourceContents {
  const children: Array<Record<string, unknown>> = [];
  for (const child of page.entries) {
    const home = toHome(joinKey(internalPrefix, child.name));
    if (home === undefined) continue;
    children.push({
      ...child.meta,
      uri: scheme + home,
      name: child.name,
      kind: child.kind,
    });
  }
  const listing: Record<string, unknown> = { uri: scheme + homePath, children };
  if (page.cursor !== undefined) {
    listing.nextPage = `${scheme}${homePath}${CURSOR}${encodeURIComponent(page.cursor)}`;
  }
  return { uri: scheme + homePath, mimeType: "application/json", text: JSON.stringify(listing) };
}

export function mount(resolver: ResourceResolver, meta?: ResourceMeta): Mount {
  return meta === undefined ? { resolver } : { resolver, meta };
}

/**
 * The computed form runs on EVERY read. There is no reliable per-principal key
 * to memoize under — `ctx.sessionId` is optional, and one shared entry under a
 * missing key serves one principal's tree to the next — so an expensive
 * membership or attribution lookup inside `tree` is the adopter's to cache.
 */
export function createTree(tree: MountTreeSource): ResourceResolver {
  const resolve = typeof tree === "function" ? tree : () => tree;
  return async (uri, ctx) => {
    const mounts = await resolve(ctx);
    const { scheme, path } = splitUri(uri);
    const { path: requested } = takeCursor(path);
    const clean = canonicalHome(requested);
    if (clean === undefined) throw new ResourceNotFound({ uri });
    if (clean === "") return [rootListing(scheme, mounts)];
    const prefix = longestMount(clean, mounts);
    if (prefix === undefined) throw new ResourceNotFound({ uri });
    return mounts[prefix].resolver(uri, ctx);
  };
}

function longestMount(path: string, mounts: MountTree): string | undefined {
  let best: string | undefined;
  for (const key of Object.keys(mounts)) {
    const under = path === key || path.startsWith(`${key}/`);
    if (under && (best === undefined || key.length > best.length)) best = key;
  }
  return best;
}

function rootListing(scheme: string, mounts: MountTree): ResourceContents {
  const children = Object.entries(mounts).map(([prefix, m]) => ({
    uri: scheme + prefix,
    name: m.meta?.name ?? prefix,
    kind: "directory" as const,
    description: m.meta?.description,
  }));
  return {
    uri: scheme,
    mimeType: "application/json",
    text: JSON.stringify({ uri: scheme, children }),
  };
}

export function registerTree(
  resources: Pick<Resources, "register" | "registerTemplate">,
  scheme: string,
  tree: MountTreeSource,
  meta?: ResourceMeta,
): Unsubscribe {
  const resolver = createTree(tree);
  const offRoot = resources.register(scheme, resolver, meta);
  const offTree = resources.registerTemplate(`${scheme}{+path}`, resolver, meta);
  return () => {
    offRoot();
    offTree();
  };
}
