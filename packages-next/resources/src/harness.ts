/**
 * `ResourcesHarness` — a read-projection seam, NOT a store (ADR 62).
 *
 * Extends {@link BaseHarness} so the read verbs journal + wire-expose
 * through the substrate's phase contract and the change stream rides the
 * inherited machinery. The harness holds a **registry of `URI →
 * resolver` bindings** (plus `uriTemplate → resolver`) and the subscribe
 * / `list_changed` notifier — it owns NO content. A resolver reads from
 * wherever the content already lives (the sandbox fs, a store, a
 * computed view); `read(uri)` routes to the matching resolver.
 *
 * **Invocation (ADR 51).** `read` / `list` / `listTemplates` are
 * DECLARED COMMANDS (`this.command()`): serializable data in, wire-safe
 * data out → journaled, inbox-addressable, and wire-enumerable exactly
 * like `prompts:get`. `register` / `registerTemplate` carry a REQUIRED
 * resolver function, so per ADR 51 §1.2 (ops with required function
 * params must NOT be declared) they stay plain in-process methods — a
 * synchronous registry insert returning an `Unsubscribe`. The change
 * stream (`subscribe` / `subscribeListChanged` / `notifyUpdated`) is a
 * notifier fan-out, also plain methods (mirrors `PromptsHarness`'s
 * `subscribe` / `subscribeAll`).
 *
 * Two distinct notifier streams — kept separate because the events are
 * semantically distinct (unlike prompts, where every change is "a
 * declaration changed"):
 *   - `subscribe(uri, listener)`   fires on `notifyUpdated(uri)`
 *     → MCP `notifications/resources/updated`.
 *   - `subscribeListChanged(listener)` fires on register / unregister
 *     → MCP `notifications/resources/list_changed`.
 *
 * @see docs/proposals/v2/blueprint/62-resources-harness.md
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
} from "@agentick/spec-next";
import {
  createKeyedNotifier,
  createNotifier,
  type KeyedNotifier,
  type Notifier,
} from "@agentick/pubsub-next";
import { omitUndefined } from "@agentick/utils-next";

import { compileUriTemplate, matchesTemplate } from "./uri-template.js";

const SURFACE = "resources" as const;
type ResourcesSurface = typeof SURFACE;

/** Default pagination page size when the caller doesn't override it. */
const DEFAULT_PAGE_SIZE = 100;

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

interface FixedBinding {
  readonly resolver: ResourceResolver;
  readonly meta?: ResourceMeta;
}

interface TemplateBinding {
  readonly resolver: TemplateResolver;
  readonly meta?: ResourceTemplateMeta;
  readonly compiled: RegExp;
}

export class ResourcesHarness
  extends BaseHarness<ResourcesSurface>
  implements ResourcesHarnessProtocol
{
  /** Fixed `uri → resolver` bindings. Insertion order is not significant. */
  private readonly fixed = new Map<string, FixedBinding>();
  /** `uriTemplate → resolver` bindings. Insertion order = match priority. */
  private readonly templates = new Map<string, TemplateBinding>();

  /** Content-update fan-out, keyed by uri (`notifyUpdated`). */
  private readonly updatedNotifier: KeyedNotifier = createKeyedNotifier();
  /** Registry-topology fan-out (`register` / unregister → `list_changed`). */
  private readonly listChangedNotifier: Notifier = createNotifier();

  /** Cached, sorted descriptor snapshots. Invalidated on every mutation. */
  private listCache: readonly ResourceDescriptor[] | null = null;
  private templatesCache: readonly ResourceTemplateDescriptor[] | null = null;

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

  // ─────────── Registration (plain methods — ADR 51 §1.2) ───────────

  register(uri: string, resolver: ResourceResolver, meta?: ResourceMeta): Unsubscribe {
    if (this.fixed.has(uri)) {
      throw new ResourceAlreadyRegistered({ uri });
    }
    this.fixed.set(uri, omitUndefined({ resolver, meta }) as FixedBinding);
    this.invalidateAndNotifyList();
    return () => {
      if (this.fixed.delete(uri)) this.invalidateAndNotifyList();
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
    this.templates.set(
      uriTemplate,
      omitUndefined({
        resolver,
        meta,
        compiled: compileUriTemplate(uriTemplate),
      }) as TemplateBinding,
    );
    this.invalidateAndNotifyList();
    return () => {
      if (this.templates.delete(uriTemplate)) this.invalidateAndNotifyList();
    };
  }

  // ─────────── Sync surface ───────────

  has(uri: string): boolean {
    return this.fixed.has(uri);
  }

  /**
   * Synchronous, unpaginated registry snapshot (sorted, cached). The
   * sync-read counterpart to {@link list} / {@link listTemplates} used
   * by the `resources` compiler-surfacing default projection.
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
    return Effect.suspend(() => {
      const resolver = this.resolverFor(input.uri);
      if (resolver === null) {
        return Effect.fail<ResourcesError>(new ResourceNotFound({ uri: input.uri }));
      }
      return Effect.tryPromise<readonly ResourceContents[], ResourcesError>({
        try: async () => resolver(input.uri),
        catch: (cause): ResourcesError => new ResourceResolverFailed({ uri: input.uri, cause }),
      });
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
    const exact = this.fixed.get(uri);
    if (exact) return exact.resolver;
    for (const binding of this.templates.values()) {
      if (matchesTemplate(binding.compiled, uri)) return binding.resolver;
    }
    return null;
  }

  private snapshotResources(): readonly ResourceDescriptor[] {
    if (this.listCache !== null) return this.listCache;
    const out: ResourceDescriptor[] = [];
    for (const [uri, binding] of this.fixed) {
      out.push(
        omitUndefined({
          uri,
          name: binding.meta?.name ?? uri,
          description: binding.meta?.description,
          mimeType: binding.meta?.mimeType,
          size: binding.meta?.size,
          title: binding.meta?.title,
          metadata: binding.meta?.metadata,
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
    for (const [uriTemplate, binding] of this.templates) {
      out.push(
        omitUndefined({
          uriTemplate,
          name: binding.meta?.name ?? uriTemplate,
          description: binding.meta?.description,
          mimeType: binding.meta?.mimeType,
          title: binding.meta?.title,
          metadata: binding.meta?.metadata,
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
