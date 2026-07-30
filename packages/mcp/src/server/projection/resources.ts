/**
 * Resources projection (ADR 62, #237) — per-connection `resources/list`,
 * `resources/templates/list`, `resources/read`, `resources/subscribe`,
 * `resources/unsubscribe`, plus the two server→client notifications
 * (`notifications/resources/updated`, `.../list_changed`) driven by the
 * `ResourcesHarness` notifier.
 *
 * The harness owns the registry (register / unregister / notifyUpdated).
 * The server harness only PROJECTS — it never mutates the registry
 * (exactly like `projection/prompts.ts`). Reads route through the
 * harness's declared `read` command; the resolver runs there.
 *
 * Every harness read composes through the crossing's `onFiber` runner
 * (`source.fx.*`, ADR 92 §Slice A) rather than the Promise facade, so the
 * `resources:command:*` op it drives is a CHILD of the `mcp:command:*`
 * crossing — inheriting its connection dim + identity — and the resolver
 * receives an `OperationCtx` carrying the caller's identity (ADR 91
 * stop-rule #2). Through the Promise facade each read would re-enter Effect
 * on a fresh root fiber and lose both.
 *
 * Provider seam only: this projects agentick's OWN resources OUT. Reading
 * an external server's resources is a `McpClientHarness` concern (Wave 2);
 * compose it via a wrapping resolver, not here.
 */

import type { Server as SdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import type {
  ListResourcesRequest,
  ListResourcesResult,
  ListResourceTemplatesRequest,
  ListResourceTemplatesResult,
  ReadResourceRequest,
  ReadResourceResult,
  Resource as McpWireResource,
  ResourceTemplate as McpWireResourceTemplate,
  SubscribeRequest,
  UnsubscribeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  McpRequestContext,
  ResourceContents,
  ResourceDescriptor,
  Resources,
  ResourcesListInput,
  ResourceTemplateDescriptor,
} from "@agentick/spec";
import type { Unsubscribe } from "@agentick/runtime";

import {
  readMcpDeclarationExtensions,
  readMetadataIcons,
  readMetadataTitle,
} from "../wire-extensions.js";
import type { McpHandlerExtra, OnCrossingFiber, RunCrossing } from "./crossing.js";

/**
 * "Resource not found". `-32602` (Invalid Params) as of protocol `2026-07-28`,
 * which renumbered it from `-32002` to stop squatting the JSON-RPC
 * implementation-defined range for something that is plainly a bad parameter.
 */
const RESOURCE_NOT_FOUND = -32602;

/**
 * Per-connection visibility predicate for FIXED resources. A hidden
 * resource is invisible to BOTH `resources/list` AND `resources/read`
 * (symmetric with the prompts filter). Templates are not filtered — a
 * templated read carries no fixed descriptor to test.
 */
export type ResourcesFilter = (descriptor: ResourceDescriptor, ctx: McpRequestContext) => boolean;

export interface ResourcesProjectionOptions {
  /** Resources source whose registry is projected onto the wire. */
  readonly source: Resources;
  /** Per-connection visibility predicate for fixed resources. */
  readonly filter?: ResourcesFilter;
  /** The crossing-operation runner for this connection (ADR 92 §Slice A). */
  readonly runCrossing: RunCrossing;
}

/**
 * Install the resources request handlers + notification fan-out on an
 * SDK Server. Returns an `Unsubscribe` — call it from the connection
 * close path to stop `list_changed` fan-out and drop every per-uri
 * `updated` subscription for this connection.
 */
export function installResourcesHandlers(
  sdkServer: SdkServer,
  options: ResourcesProjectionOptions,
): Unsubscribe {
  const { source, filter, runCrossing } = options;

  // ─────────── resources/list ───────────
  sdkServer.setRequestHandler(
    ListResourcesRequestSchema,
    async (request: ListResourcesRequest, extra: McpHandlerExtra): Promise<ListResourcesResult> =>
      runCrossing({
        verb: "list-resources",
        operation: { type: "resource_list" },
        signal: extra.signal,
        run: async (_input, ctx, onFiber): Promise<ListResourcesResult> => {
          const page = await onFiber(source.fx.list(cursorInput(request.params?.cursor)));
          const projected = filter ? page.resources.filter((r) => filter(r, ctx)) : page.resources;
          const result: ListResourcesResult = { resources: projected.map(toWireResource) };
          if (page.nextCursor !== undefined) result.nextCursor = page.nextCursor;
          return result;
        },
      }),
  );

  // ─────────── resources/templates/list ───────────
  sdkServer.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async (
      request: ListResourceTemplatesRequest,
      extra: McpHandlerExtra,
    ): Promise<ListResourceTemplatesResult> =>
      runCrossing({
        verb: "list-resource-templates",
        operation: { type: "resource_list" },
        signal: extra.signal,
        run: async (_input, _ctx, onFiber): Promise<ListResourceTemplatesResult> => {
          const page = await onFiber(source.fx.listTemplates(cursorInput(request.params?.cursor)));
          const result: ListResourceTemplatesResult = {
            resourceTemplates: page.templates.map(toWireResourceTemplate),
          };
          if (page.nextCursor !== undefined) result.nextCursor = page.nextCursor;
          return result;
        },
      }),
  );

  // ─────────── resources/read ───────────
  sdkServer.setRequestHandler(
    ReadResourceRequestSchema,
    async (request: ReadResourceRequest, extra: McpHandlerExtra): Promise<ReadResourceResult> =>
      runCrossing({
        verb: "read-resource",
        operation: { type: "resource_read", name: request.params.uri },
        params: { uri: request.params.uri },
        signal: extra.signal,
        run: async (_input, ctx, onFiber): Promise<ReadResourceResult> => {
          // A fixed resource hidden by the per-connection filter must not be
          // readable either. Templated / unknown uris carry no fixed
          // descriptor, so the filter doesn't apply — the harness decides
          // found / not-found. Only pay the catalog walk when a filter is set.
          if (filter && !(await isReadable(source, filter, ctx, onFiber, request.params.uri))) {
            throw notFound(request.params.uri);
          }

          // ON THE CROSSING'S FIBER (ADR 92 §Slice A): `resources:command:read`
          // runs as a CHILD of this crossing, so the resolver's `OperationCtx`
          // carries the caller's identity + the connection dim. `onFiber`
          // normalizes the Exit exactly like the Promise facade did, so
          // `ResourceNotFound` still arrives as itself.
          //
          // ADR 91 — a `ResourceResolver(uri, ctx)` receives the REDACTED trunk identity
          // (`ctx.identity`, what the journal records) PLUS the `mcp` boundary
          // facet (`ctx.mcp.user`, the caller's authenticated record with its
          // credential) — in-fiber only, never serialized. The crossing publishes
          // it via `withBoundaryFacets`; `currentOperationCtx` folds it in as
          // `deriveContext`'s extras.
          try {
            const contents = await onFiber(source.fx.read({ uri: request.params.uri }));
            return { contents: contents.map(toWireContents) };
          } catch (err) {
            if (isResourceNotFound(err)) throw notFound(request.params.uri);
            throw err;
          }
        },
      }),
  );

  // ─────────── resources/subscribe + unsubscribe ───────────
  // Per-connection interest set. `resources/subscribe` binds a listener
  // that fans `notifications/resources/updated`; unsubscribe (or
  // connection close) tears it down.
  const perUriUnsub = new Map<string, Unsubscribe>();

  sdkServer.setRequestHandler(
    SubscribeRequestSchema,
    async (request: SubscribeRequest, extra: McpHandlerExtra): Promise<Record<string, never>> =>
      runCrossing({
        verb: "subscribe-resource",
        operation: { type: "resource_read", name: request.params.uri },
        params: { uri: request.params.uri },
        signal: extra.signal,
        run: async (): Promise<Record<string, never>> => {
          const uri = request.params.uri;
          if (!perUriUnsub.has(uri)) {
            const unsub = source.subscribe(uri, () => {
              void sdkServer.sendResourceUpdated({ uri }).catch(() => {
                // Connection closing mid-notification — drop. The harness
                // change still happened; a fresh read reflects it.
              });
            });
            perUriUnsub.set(uri, unsub);
          }
          return {};
        },
      }),
  );

  sdkServer.setRequestHandler(
    UnsubscribeRequestSchema,
    async (request: UnsubscribeRequest, extra: McpHandlerExtra): Promise<Record<string, never>> =>
      runCrossing({
        verb: "unsubscribe-resource",
        operation: { type: "resource_read", name: request.params.uri },
        params: { uri: request.params.uri },
        signal: extra.signal,
        run: async (): Promise<Record<string, never>> => {
          const unsub = perUriUnsub.get(request.params.uri);
          if (unsub) {
            unsub();
            perUriUnsub.delete(request.params.uri);
          }
          return {};
        },
      }),
  );

  // ─────────── notifications/resources/list_changed ───────────
  const listChangedUnsub = source.subscribeAll(() => {
    void sdkServer.sendResourceListChanged().catch(() => {
      // Connection probably closed mid-notification — silently drop.
    });
  });

  return () => {
    listChangedUnsub();
    for (const unsub of perUriUnsub.values()) unsub();
    perUriUnsub.clear();
  };
}

// ============================================================================
// Wire mappers
// ============================================================================

/**
 * Convert a v2 `ResourceDescriptor` to the MCP wire `Resource` shape.
 *
 * Display + extension fields follow the conventions shared with the tools
 * and prompts projections: `metadata.title` overrides the first-class
 * `title`, `metadata.icons` → wire `icons`, and `metadata.mcp.meta` →
 * wire `_meta` ({@link McpDeclarationExtensions}). Absent ⇒ not emitted.
 */
export function toWireResource(descriptor: ResourceDescriptor): McpWireResource {
  const wire: McpWireResource = { uri: descriptor.uri, name: descriptor.name };
  if (descriptor.description !== undefined) wire.description = descriptor.description;
  if (descriptor.mimeType !== undefined) wire.mimeType = descriptor.mimeType;
  if (descriptor.size !== undefined) wire.size = descriptor.size;
  applyDisplayMetadata(wire, descriptor);
  return wire;
}

/** Convert a v2 `ResourceTemplateDescriptor` to the MCP wire shape. */
export function toWireResourceTemplate(
  descriptor: ResourceTemplateDescriptor,
): McpWireResourceTemplate {
  const wire: McpWireResourceTemplate = {
    uriTemplate: descriptor.uriTemplate,
    name: descriptor.name,
  };
  if (descriptor.description !== undefined) wire.description = descriptor.description;
  if (descriptor.mimeType !== undefined) wire.mimeType = descriptor.mimeType;
  applyDisplayMetadata(wire, descriptor);
  return wire;
}

/**
 * Stamp `title` / `icons` / `_meta` onto a wire resource record. The two
 * descriptor shapes differ only in their locator field, so the display +
 * extension carriage is written once. Mutates in place — both callers own
 * a freshly built wire object.
 */
function applyDisplayMetadata(
  wire: { title?: string; icons?: unknown; _meta?: unknown },
  descriptor: ResourceDescriptor | ResourceTemplateDescriptor,
): void {
  const title = readMetadataTitle(descriptor.metadata) ?? descriptor.title;
  if (title !== undefined) wire.title = title;
  const icons = readMetadataIcons(descriptor.metadata);
  if (icons !== undefined) wire.icons = icons;
  const meta = readMcpDeclarationExtensions(descriptor.metadata)?.meta;
  if (meta !== undefined) wire._meta = meta;
}

/**
 * Map a v2 `ResourceContents` to the MCP wire contents shape. The two
 * are structurally identical (text/blob union with `uri` + optional
 * `mimeType` + `_meta`); we discriminate explicitly to keep the wire
 * type narrow.
 */
export function toWireContents(contents: ResourceContents): ReadResourceResult["contents"][number] {
  if ("text" in contents) {
    return {
      uri: contents.uri,
      ...(contents.mimeType !== undefined ? { mimeType: contents.mimeType } : {}),
      ...(contents._meta !== undefined ? { _meta: contents._meta } : {}),
      text: contents.text,
    };
  }
  return {
    uri: contents.uri,
    ...(contents.mimeType !== undefined ? { mimeType: contents.mimeType } : {}),
    ...(contents._meta !== undefined ? { _meta: contents._meta } : {}),
    blob: contents.blob,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * True iff `uri` is readable for this connection: either it is not a
 * fixed resource (templated / unknown — no descriptor to filter, the
 * harness decides), or it is a fixed resource the filter admits. Walks
 * the paginated catalog only when a filter is set.
 */
async function isReadable(
  source: Resources,
  filter: ResourcesFilter,
  ctx: McpRequestContext,
  onFiber: OnCrossingFiber,
  uri: string,
): Promise<boolean> {
  let cursor: string | undefined;
  do {
    const page = await onFiber(source.fx.list(cursorInput(cursor)));
    const match = page.resources.find((r) => r.uri === uri);
    if (match) return filter(match, ctx);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  // Not a fixed resource — templated or unknown; let the harness decide.
  return true;
}

/**
 * The command-input form of the positional `list(cursor?)` sugar. `cursor` is
 * optional-ABSENT on the input record, so an undefined wire cursor must be
 * omitted rather than passed as `undefined`.
 */
function cursorInput(cursor: string | undefined): ResourcesListInput {
  return cursor !== undefined ? { cursor } : {};
}

function isResourceNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { _tag?: unknown })._tag === "ResourceNotFound"
  );
}

function notFound(uri: string): Error & { code: number } {
  return Object.assign(new Error(`Resource not found: ${uri}`), { code: RESOURCE_NOT_FOUND });
}
