/**
 * `ResourcesHarness` — a read-projection seam, store-BACKED but NOT
 * `SnapshotCapable` (ADR 62 + data-layer plan §6-C, Phase 5 run #9).
 *
 * Extends {@link BaseHarness} so the read verbs journal + wire-expose through the
 * substrate's phase contract and the change stream rides the inherited machinery.
 * The harness owns NO content: a resolver reads from wherever the content already
 * lives (the sandbox fs, a store, a computed view); `read(uri)` routes to the
 * matching resolver.
 *
 * ## The three internal structures (data-layer plan run #9, "option a")
 *
 * Resources is the definition-library archetype's richest instance. Its state is
 * split across three structures:
 *
 *   1. **Durable store** ({@link ResourceStore}) — holds the SERIALIZABLE
 *      {@link ResourceDeclarationRecord} slice (`uri` / `uriTemplate` / `kind` / `meta`)
 *      for **durable** resources sourced from a {@link ResourceLoader} (DB / fs —
 *      the source resources lacks today). Transient bindings NEVER touch it.
 *   2. **Eager catalog projection** ({@link fixed} / {@link templates}) — the
 *      synchronous, sorted, cached declaration slice `snapshot()` reads (folded
 *      into the IR during a render pass — data-layer plan §3.5 P5 "render-read").
 *      It overlays BOTH durable declarations (mirrored from the store) AND
 *      transient declarations (from `register` / `registerTemplate` / `<Resource>`
 *      tree-mounts). Authoritative for presence (`has`) + the catalog.
 *   3. **Resolver sidecar** ({@link fixedResolvers} / {@link templateResolvers}) —
 *      the NON-serializable `resolver` fn (+ a template's compiled `RegExp`),
 *      keyed by uri / uriTemplate, for BOTH durable-from-loader AND
 *      transient-from-register bindings. `resolverFor` reads it (fixed-first, then
 *      template-match). NEVER reaches the store — the `ResourceDeclarationRecord` type
 *      makes that a compile-time guarantee (mirrors prompts' `render`/`template`
 *      sidecar).
 *
 * ## NOT `SnapshotCapable` — store-backed ≠ snapshot-backed
 *
 * The harness carries NO `exportSnapshot`/`importSnapshot`. Durability = the
 * store reloads durable declarations from its `ResourceLoader` source on restart
 * (`reload()`); transient bindings re-mount from the tree. On restart the catalog
 * projection surfaces the durable declarations (`hydrate()` from the store) but
 * resolvers do not survive serialization — `read()` throws `ResourceNotFound`
 * until the loaders re-run and re-attach the sidecar, exactly as a restored
 * prompt has no content until re-registered. This is the clean "store-backed but
 * not snapshot-backed" case (data-layer plan §3 disposition).
 *
 * **Invocation (ADR 51).** `read` / `list` / `listTemplates` are DECLARED
 * COMMANDS. `register` / `registerTemplate` carry a REQUIRED resolver function
 * (ADR 51 §1.2) so they stay plain in-process methods — a synchronous registry
 * insert returning an `Unsubscribe`. Two distinct notifier streams:
 *   - `subscribe(uri, listener)`   fires on `notifyUpdated(uri)`
 *     → MCP `notifications/resources/updated`.
 *   - `subscribeListChanged(listener)` fires on register / unregister / reload
 *     → MCP `notifications/resources/list_changed`.
 *
 * @see docs/proposals/v2/blueprint/62-resources-harness.md
 * @see docs/proposals/v2/data-layer-plan.md §6-C
 * @see packages-next/spec/src/protocol/resources-harness.ts
 */

import { Effect } from "effect";
import { BaseHarness, type Middleware, type Unsubscribe } from "@agentick/runtime-next";
import type {
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
  ResourceContents,
  ResourceDescriptor,
  ResourceMeta,
  ResourceResolver,
  ResourcesError,
  ResourcesHarnessProtocol,
  ResourcesListInput,
  ResourcesListResult,
  ResourcesListTemplatesInput,
  ResourcesListTemplatesResult,
  ResourcesReadInput,
  ResourcesSnapshot,
  ResourceStore,
  ResourceTemplateDescriptor,
  ResourceTemplateMeta,
  TemplateResolver,
} from "@agentick/spec-next";
import {
  HandlerError,
  ResourceAlreadyRegistered,
  ResourceNotFound,
  ResourceResolverFailed,
  ResourcesBackendError,
  resourceDeclarationKey,
} from "@agentick/spec-next";
import {
  createKeyedNotifier,
  createNotifier,
  type KeyedNotifier,
  type Notifier,
} from "@agentick/pubsub-next";
import { omitUndefined } from "@agentick/utils-next";

import type { ResourceLoader, ResourceLoaderItem } from "./loaders.js";
import { InMemoryResourceStore } from "./store.js";
import { compileUriTemplate, matchesTemplate } from "./uri-template.js";

const SURFACE = "resources" as const;
type ResourcesSurface = typeof SURFACE;

/** Default pagination page size when the caller doesn't override it. */
const DEFAULT_PAGE_SIZE = 100;

/** A template's non-serializable sidecar entry: the resolver + its compiled pattern. */
interface TemplateResolverEntry {
  readonly resolver: TemplateResolver;
  readonly compiled: RegExp;
}

export interface ResourcesHarnessOptions {
  /**
   * Page size for `list` / `listTemplates`. Defaults to
   * {@link DEFAULT_PAGE_SIZE}. Small values let tests exercise the
   * cursor path against a handful of registrations.
   */
  readonly pageSize?: number;
  /** Backend discriminator surfaced via `.backend`. Default `"memory"`. */
  readonly backend?: string;
  /**
   * Durable backing for the DURABLE resource declarations (data-layer plan §6-C,
   * Phase 5 run #9). Defaults to a fresh per-harness in-memory
   * {@link InMemoryResourceStore}. The store holds ONLY the serializable
   * {@link ResourceDeclarationRecord} slice — the `resolver` fn stays in the harness's
   * sidecar and never reaches it. Injecting a durable adapter is how durable
   * resource declarations survive process restart; `reload()` re-runs the
   * loaders (the source) and `hydrate()` mirrors the store into the catalog
   * projection. **Transient** register / `<Resource>` bindings never touch the
   * store (they re-mount from the tree), so the harness is deliberately NOT
   * `SnapshotCapable`.
   */
  readonly store?: ResourceStore;
  /**
   * Loaders for DURABLE resources (data-layer plan Phase 5). Retained for
   * post-startup `reload()` + lookup-on-miss in `read()`; each loaded item
   * carries a {@link ResourceDeclarationRecord} (→ store) and its live `resolver`
   * (→ sidecar). Adopters can also swap the loader set at runtime via
   * {@link ResourcesHarness.setLoaders}.
   */
  readonly loaders?: readonly ResourceLoader[];
  /**
   * Resolved interceptor snapshot (ADR 76 tier 3 + ADR 83 amendment) — the
   * parent scope's resolved interceptors (guards, `.use` transforms, AND
   * declarative command hooks adapted to op-scoped middleware), folded in at
   * construction and forwarded to {@link BaseHarness} so ancestor-scope
   * interceptors wrap this harness's ops. Defaults to `[]`.
   */
  readonly inheritedInterceptors?: readonly Middleware<unknown, unknown, unknown>[];
  /**
   * LIVE interceptor parent (ADR 83 §4) — the AppHarness (this per-session
   * harness is constructed by the app). Keeps inheritance live so a LATER
   * `app.use()` / `app.guard()` / `app.hook()` reaches this harness's ops, not
   * just the construction snapshot. Forwarded to {@link BaseHarness}.
   */
  readonly interceptorParent?: BaseHarness;
}

export class ResourcesHarness
  extends BaseHarness<ResourcesSurface>
  implements ResourcesHarnessProtocol
{
  /**
   * Eager catalog projection — fixed `uri → meta` declaration slice (data-layer
   * plan §3.5 P5). Durable declarations mirrored from {@link store} PLUS transient
   * `register` / `<Resource>` declarations overlaid. Authoritative for `has()` +
   * `snapshot()`. Insertion order is not significant for fixed resources.
   */
  private readonly fixed = new Map<string, ResourceMeta | undefined>();
  /**
   * Eager catalog projection — `uriTemplate → meta` declaration slice. Insertion
   * order = match priority (mirrored into {@link templateResolvers}).
   */
  private readonly templates = new Map<string, ResourceTemplateMeta | undefined>();

  /**
   * Resolver sidecar — fixed `uri → resolver`. NON-serializable; never reaches
   * the store. Holds resolvers for BOTH durable-from-loader AND
   * transient-from-register bindings. After `hydrate()` on restart this map is
   * empty (resolvers don't survive) until the loaders re-run.
   */
  private readonly fixedResolvers = new Map<string, ResourceResolver>();
  /** Resolver sidecar — `uriTemplate → { resolver, compiled RegExp }`. */
  private readonly templateResolvers = new Map<string, TemplateResolverEntry>();

  /** Content-update fan-out, keyed by uri (`notifyUpdated`). */
  private readonly updatedNotifier: KeyedNotifier = createKeyedNotifier();
  /** Registry-topology fan-out (`register` / unregister / reload → `list_changed`). */
  private readonly listChangedNotifier: Notifier = createNotifier();

  /** Cached, sorted descriptor snapshots. Invalidated on every mutation. */
  private listCache: readonly ResourceDescriptor[] | null = null;
  private templatesCache: readonly ResourceTemplateDescriptor[] | null = null;

  /**
   * Durable backing for DURABLE declarations (data-layer plan §6-C). Fed by
   * loaders only; transient bindings never write to it. The catalog projection
   * is the sync read cache — reads never touch the (async) store.
   */
  private readonly store: ResourceStore;

  /** Loaders for durable resources — drive `reload()` + lookup-on-miss in `read()`. */
  private loaders: readonly ResourceLoader[] = [];

  private readonly pageSize: number;
  readonly backend: string;

  /**
   * Declared commands (ADR 51). Assigned in the constructor; the public
   * positional methods ({@link read} / {@link list} / {@link listTemplates})
   * wrap these so the protocol reads ergonomically (`read(uri)`) while
   * every call still routes through `runOperation` — phase contract,
   * journaling, idempotency, middleware.
   */
  private readonly readCommand: (input: ResourcesReadInput) => Promise<readonly ResourceContents[]>;
  private readonly listCommand: (input: ResourcesListInput) => Promise<ResourcesListResult>;
  private readonly listTemplatesCommand: (
    input: ResourcesListTemplatesInput,
  ) => Promise<ResourcesListTemplatesResult>;

  get id(): string {
    return this.scopeId;
  }

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: ResourcesHarnessOptions = {},
  ) {
    super(SURFACE, scopeId, journal, bus, inbox, {
      inheritedInterceptors: options.inheritedInterceptors,
      interceptorParent: options.interceptorParent,
    });
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.backend = options.backend ?? "memory";
    this.store = options.store ?? new InMemoryResourceStore();
    if (options.loaders && options.loaders.length > 0) {
      this.loaders = options.loaders;
    }

    const scope = () => ({ sessionId: this.scopeId });
    this.readCommand = this.command({
      name: "resources:read",
      // Application-controlled read surface — grantable, deny-by-default.
      exposure: "wire",
      scope,
      handler: (i: ResourcesReadInput) => this.applyRead(i),
    });
    this.listCommand = this.command({
      name: "resources:list",
      exposure: "wire",
      scope,
      handler: (i: ResourcesListInput) => this.applyList(i),
    });
    this.listTemplatesCommand = this.command({
      name: "resources:listTemplates",
      exposure: "wire",
      scope,
      handler: (i: ResourcesListTemplatesInput) => this.applyListTemplates(i),
    });
  }

  /**
   * Replace the loader set used by `reload()` and the lookup-on-miss fallback in
   * `read()`. Called by the AppHarness at install time (once the durable-source
   * plumbing lands, see the extension TODO); adopters can also swap it at runtime.
   */
  setLoaders(loaders: readonly ResourceLoader[]): void {
    this.loaders = loaders;
  }

  // ─────────── Registration (plain methods — ADR 51 §1.2, TRANSIENT) ───────────

  register(uri: string, resolver: ResourceResolver, meta?: ResourceMeta): Unsubscribe {
    if (this.fixed.has(uri)) {
      throw new ResourceAlreadyRegistered({ uri });
    }
    // TRANSIENT: projection + resolver sidecar, NEVER the store (re-mounts on restart).
    this.fixed.set(uri, meta);
    this.fixedResolvers.set(uri, resolver);
    this.invalidateAndNotifyList();
    return () => {
      if (this.fixed.delete(uri)) {
        this.fixedResolvers.delete(uri);
        this.invalidateAndNotifyList();
      }
    };
  }

  registerTemplate(
    uriTemplate: string,
    resolver: TemplateResolver,
    meta?: ResourceTemplateMeta,
  ): Unsubscribe {
    if (this.templates.has(uriTemplate)) {
      throw new ResourceAlreadyRegistered({ uri: uriTemplate });
    }
    // TRANSIENT: projection + resolver sidecar, NEVER the store.
    this.templates.set(uriTemplate, meta);
    this.templateResolvers.set(uriTemplate, {
      resolver,
      compiled: compileUriTemplate(uriTemplate),
    });
    this.invalidateAndNotifyList();
    return () => {
      if (this.templates.delete(uriTemplate)) {
        this.templateResolvers.delete(uriTemplate);
        this.invalidateAndNotifyList();
      }
    };
  }

  // ─────────── Durable source (loaders → store + projection + sidecar) ───────────

  /**
   * Re-run every configured loader and upsert each loaded item into the durable
   * store (declaration), the catalog projection (declaration), and the resolver
   * sidecar (resolver fn). Returns the keys touched, split into first-seen
   * (`added`) vs already-present (`updated`). Fires `list_changed` once.
   *
   * Unlike `register`, this is an UPSERT (re-running a loader refreshes its
   * declarations) — it does NOT throw on an existing key.
   */
  async reload(): Promise<{
    readonly added: readonly string[];
    readonly updated: readonly string[];
  }> {
    const batches = await Promise.all(this.loaders.map((l) => l.load()));
    const added: string[] = [];
    const updated: string[] = [];
    for (const batch of batches) {
      for (const item of batch) {
        const key = resourceDeclarationKey(item.declaration);
        const existed = this.fixed.has(key) || this.templates.has(key);
        await this.putDurable(item);
        (existed ? updated : added).push(key);
      }
    }
    this.invalidateAndNotifyList();
    return { added, updated };
  }

  /**
   * Load the durable store into the catalog projection — the future manifest
   * resume path (data-layer plan Phase 4). Mirrors DECLARATIONS only; the
   * resolver sidecar is NOT touched (resolvers don't survive serialization), so a
   * hydrated resource surfaces in the catalog but `read()` throws
   * `ResourceNotFound` until the loaders re-run (`reload()`) and re-attach the
   * resolver. NOT wired into session resume in this run.
   */
  async hydrate(): Promise<void> {
    const declarations = await this.store.list(undefined, this.storeCtx());
    for (const d of declarations) {
      if (d.kind === "template" && d.uriTemplate !== undefined) {
        this.templates.set(d.uriTemplate, d.meta);
      } else if (d.uri !== undefined) {
        this.fixed.set(d.uri, d.meta);
      }
    }
    this.invalidateAndNotifyList();
  }

  /**
   * Upsert one durable loader item into store + projection + sidecar. Does NOT
   * notify (callers batch the notification). The store write is awaited so
   * durability errors surface to the async caller.
   */
  private async putDurable(item: ResourceLoaderItem): Promise<void> {
    const d = item.declaration;
    await this.store.put(d, this.storeCtx());
    if (d.kind === "template" && d.uriTemplate !== undefined) {
      this.templates.set(d.uriTemplate, d.meta);
      this.templateResolvers.set(d.uriTemplate, {
        resolver: item.resolver,
        compiled: compileUriTemplate(d.uriTemplate),
      });
    } else if (d.uri !== undefined) {
      this.fixed.set(d.uri, d.meta);
      this.fixedResolvers.set(d.uri, item.resolver);
    }
  }

  /**
   * Lookup-on-miss: ask each loader for the exact key, and on a hit populate
   * store + projection + sidecar. Returns whether any loader had it. Keys by the
   * concrete uri, so this resolves FIXED resources (a template's key is its
   * pattern, which a concrete read-uri won't equal).
   */
  private async resolveFromLoaders(uri: string): Promise<boolean> {
    for (const loader of this.loaders) {
      const found = loader.lookup
        ? await loader.lookup(uri)
        : ((await loader.load()).find((i) => resourceDeclarationKey(i.declaration) === uri) ??
          null);
      if (found) {
        await this.putDurable(found);
        this.invalidateAndNotifyList();
        return true;
      }
    }
    return false;
  }

  // ─────────── Sync surface ───────────

  has(uri: string): boolean {
    return this.fixed.has(uri);
  }

  /**
   * Synchronous, unpaginated registry snapshot (sorted, cached). The sync-read
   * counterpart to {@link list} / {@link listTemplates} used by the `resources`
   * compiler-surfacing default projection — folds the combined durable+transient
   * catalog into the IR during a render pass (ADR 63).
   */
  snapshot(): ResourcesSnapshot {
    return {
      resources: this.snapshotResources(),
      templates: this.snapshotTemplates(),
    };
  }

  // ─────────── Reads (public positional wrappers) ───────────

  read(uri: string): Promise<readonly ResourceContents[]> {
    return this.readCommand({ uri });
  }

  list(cursor?: string): Promise<ResourcesListResult> {
    return this.listCommand(cursor !== undefined ? { cursor } : {});
  }

  listTemplates(cursor?: string): Promise<ResourcesListTemplatesResult> {
    return this.listTemplatesCommand(cursor !== undefined ? { cursor } : {});
  }

  // ─────────── Change stream (notifier-based) ───────────

  subscribe(uri: string, listener: () => void): Unsubscribe {
    return this.updatedNotifier.subscribe(uri, listener);
  }

  subscribeListChanged(listener: () => void): Unsubscribe {
    return this.listChangedNotifier.subscribe(listener);
  }

  notifyUpdated(uri: string): void {
    this.updatedNotifier.notify(uri);
  }

  // ─────────── Inbox routing ───────────

  /**
   * `resources:read/list/listTemplates` are declared commands — routed
   * by the BaseHarness command registry before this fallthrough. Only
   * unknown types land here.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: `Unknown resources message type: ${msg.type}` }));
  }

  // ─────────── Command bodies ───────────

  private applyRead(
    input: ResourcesReadInput,
  ): Effect.Effect<readonly ResourceContents[], ResourcesError, never> {
    return Effect.tryPromise({
      try: async (): Promise<readonly ResourceContents[]> => {
        let resolver = this.resolverFor(input.uri);
        // Lookup-on-miss: an unresolved uri asks the durable loaders, which
        // re-attach the resolver to the sidecar on a hit.
        if (resolver === null && this.loaders.length > 0) {
          await this.resolveFromLoaders(input.uri);
          resolver = this.resolverFor(input.uri);
        }
        if (resolver === null) throw new ResourceNotFound({ uri: input.uri });
        return resolver(input.uri);
      },
      // A ResourcesError (ResourceNotFound) passes through as-is; anything the
      // resolver throws is wrapped as a resolver failure.
      catch: (cause): ResourcesError =>
        isResourcesError(cause) ? cause : new ResourceResolverFailed({ uri: input.uri, cause }),
    });
  }

  private applyList(
    input: ResourcesListInput,
  ): Effect.Effect<ResourcesListResult, ResourcesError, never> {
    return Effect.try({
      try: (): ResourcesListResult => {
        const all = this.snapshotResources();
        const { page, nextCursor } = paginate(all, input.cursor, this.pageSize);
        return omitUndefined({ resources: page, nextCursor }) as ResourcesListResult;
      },
      catch: (cause): ResourcesError => new ResourcesBackendError({ cause }),
    });
  }

  private applyListTemplates(
    input: ResourcesListTemplatesInput,
  ): Effect.Effect<ResourcesListTemplatesResult, ResourcesError, never> {
    return Effect.try({
      try: (): ResourcesListTemplatesResult => {
        const all = this.snapshotTemplates();
        const { page, nextCursor } = paginate(all, input.cursor, this.pageSize);
        return omitUndefined({ templates: page, nextCursor }) as ResourcesListTemplatesResult;
      },
      catch: (cause): ResourcesError => new ResourcesBackendError({ cause }),
    });
  }

  // ─────────── Internals ───────────

  /** Fixed binding wins; then the first template whose pattern matches. */
  private resolverFor(uri: string): ResourceResolver | TemplateResolver | null {
    const exact = this.fixedResolvers.get(uri);
    if (exact) return exact;
    for (const entry of this.templateResolvers.values()) {
      if (matchesTemplate(entry.compiled, uri)) return entry.resolver;
    }
    return null;
  }

  private snapshotResources(): readonly ResourceDescriptor[] {
    if (this.listCache !== null) return this.listCache;
    const out: ResourceDescriptor[] = [];
    for (const [uri, meta] of this.fixed) {
      out.push(
        omitUndefined({
          uri,
          name: meta?.name ?? uri,
          description: meta?.description,
          mimeType: meta?.mimeType,
          size: meta?.size,
          title: meta?.title,
          metadata: meta?.metadata,
        }) as ResourceDescriptor,
      );
    }
    out.sort((a, b) => a.uri.localeCompare(b.uri));
    this.listCache = out;
    return out;
  }

  private snapshotTemplates(): readonly ResourceTemplateDescriptor[] {
    if (this.templatesCache !== null) return this.templatesCache;
    const out: ResourceTemplateDescriptor[] = [];
    for (const [uriTemplate, meta] of this.templates) {
      out.push(
        omitUndefined({
          uriTemplate,
          name: meta?.name ?? uriTemplate,
          description: meta?.description,
          mimeType: meta?.mimeType,
          title: meta?.title,
          metadata: meta?.metadata,
        }) as ResourceTemplateDescriptor,
      );
    }
    out.sort((a, b) => a.uriTemplate.localeCompare(b.uriTemplate));
    this.templatesCache = out;
    return out;
  }

  private invalidateAndNotifyList(): void {
    this.listCache = null;
    this.templatesCache = null;
    this.listChangedNotifier.notify();
  }
}

// ============================================================================
// Error discrimination
// ============================================================================

const RESOURCES_ERROR_TAGS = [
  "ResourceNotFound",
  "ResourceAlreadyRegistered",
  "ResourceResolverFailed",
  "ResourcesBackendError",
] as const;

function isResourcesError(value: unknown): value is ResourcesError {
  if (typeof value !== "object" || value === null) return false;
  const tag = (value as { _tag?: unknown })._tag;
  if (typeof tag !== "string") return false;
  return (RESOURCES_ERROR_TAGS as readonly string[]).includes(tag);
}

// ============================================================================
// Pagination — opaque, offset-based cursor
// ============================================================================

/**
 * Slice `all` into a page starting at the offset encoded by `cursor`.
 * The cursor is the decimal string of the next offset — opaque to
 * callers, cheap to produce, and stable for a stable sort order.
 */
function paginate<T>(
  all: readonly T[],
  cursor: string | undefined,
  pageSize: number,
): { readonly page: readonly T[]; readonly nextCursor: string | undefined } {
  const start = cursor !== undefined ? Number.parseInt(cursor, 10) : 0;
  const offset = Number.isNaN(start) || start < 0 ? 0 : start;
  const page = all.slice(offset, offset + pageSize);
  const nextOffset = offset + pageSize;
  const nextCursor = nextOffset < all.length ? String(nextOffset) : undefined;
  return { page, nextCursor };
}
