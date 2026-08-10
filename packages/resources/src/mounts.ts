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
 * @see packages/resources/README.md §Mounting stores as a resource tree
 */

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
  listChildren(prefix: string, ctx?: OperationCtx, cursor?: string): Promise<Page<Child>>;
}

export interface Child {
  readonly name: string;
  readonly kind: "directory" | "leaf";
  readonly meta?: ResourceMeta;
}

export interface Page<T> {
  readonly entries: readonly T[];
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

export function storeResolver(store: MountStore, projection?: MountProjection): ResourceResolver {
  const toInternal = (home: string) => (projection ? projection.toInternal(home) : home);
  const toHome = (key: string): string | undefined => (projection ? projection.toHome(key) : key);
  return async (uri, ctx) => {
    const { scheme, path: raw } = splitUri(uri);
    const { path, cursor } = takeCursor(raw);
    const internal = toInternal(path);
    const content = await store.get(internal, ctx);
    if (content !== undefined) {
      const home = scheme + path;
      return content.map((c) => ({ ...c, uri: home }));
    }
    const page = await store.listChildren(internal, ctx, cursor);
    return [directoryListing(scheme, path, internal, page, toHome)];
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
      uri: scheme + home,
      name: child.name,
      kind: child.kind,
      description: child.meta?.description,
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

export function createTree(
  tree: MountTree | ((ctx: OperationCtx) => MountTree | Promise<MountTree>),
): ResourceResolver {
  const resolve = typeof tree === "function" ? tree : () => tree;
  const memo = new Map<string, Promise<MountTree>>();
  const treeFor = (ctx?: OperationCtx): Promise<MountTree> => {
    const key = ctx?.sessionId ?? "";
    let t = memo.get(key);
    if (t === undefined) {
      t = Promise.resolve(resolve(ctx as OperationCtx));
      memo.set(key, t);
    }
    return t;
  };
  return async (uri, ctx) => {
    const mounts = await treeFor(ctx);
    const { scheme, path } = splitUri(uri);
    const { path: clean } = takeCursor(path);
    if (clean === "") return [rootListing(scheme, mounts)];
    const prefix = longestMount(clean, mounts);
    if (prefix === undefined) throw new Error(`resources: no mount for "${clean}"`);
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
  tree: MountTree | ((ctx: OperationCtx) => MountTree | Promise<MountTree>),
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
