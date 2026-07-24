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
  ResourceTemplateDescriptor,
} from "@agentick/spec-next";
import type { Unsubscribe } from "@agentick/runtime-next";

import { evaluateRequestPipeline } from "../security/pipeline.js";
import type { ResolvedSecurity } from "../security/stages.js";

/** JSON-RPC error code MCP reserves for "resource not found". */
const RESOURCE_NOT_FOUND = -32002;

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
  /** Security pipeline resolved for this server. */
  readonly security: ResolvedSecurity;
  /** Connection-scoped context base (cloned + augmented per-request). */
  readonly buildContext: () => McpRequestContext;
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
  const { source, filter, security } = options;

  // ─────────── resources/list ───────────
  sdkServer.setRequestHandler(
    ListResourcesRequestSchema,
    async (request: ListResourcesRequest): Promise<ListResourcesResult> => {
      const baseCtx = options.buildContext();
      const { ctx } = await evaluateRequestPipeline(security, baseCtx, { type: "resource_list" });
      const page = await source.list(request.params?.cursor);
      const projected = filter ? page.resources.filter((r) => filter(r, ctx)) : page.resources;
      const result: ListResourcesResult = { resources: projected.map(toWireResource) };
      if (page.nextCursor !== undefined) result.nextCursor = page.nextCursor;
      return result;
    },
  );

  // ─────────── resources/templates/list ───────────
  sdkServer.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async (request: ListResourceTemplatesRequest): Promise<ListResourceTemplatesResult> => {
      const baseCtx = options.buildContext();
      await evaluateRequestPipeline(security, baseCtx, { type: "resource_list" });
      const page = await source.listTemplates(request.params?.cursor);
      const result: ListResourceTemplatesResult = {
        resourceTemplates: page.templates.map(toWireResourceTemplate),
      };
      if (page.nextCursor !== undefined) result.nextCursor = page.nextCursor;
      return result;
    },
  );

  // ─────────── resources/read ───────────
  sdkServer.setRequestHandler(
    ReadResourceRequestSchema,
    async (request: ReadResourceRequest): Promise<ReadResourceResult> => {
      const baseCtx = options.buildContext();
      const { ctx } = await evaluateRequestPipeline(security, baseCtx, {
        type: "resource_read",
        name: request.params.uri,
      });

      // A fixed resource hidden by the per-connection filter must not be
      // readable either. Templated / unknown uris carry no fixed
      // descriptor, so the filter doesn't apply — the harness decides
      // found / not-found. Only pay the catalog walk when a filter is set.
      if (filter && !(await isReadable(source, filter, ctx, request.params.uri))) {
        throw notFound(request.params.uri);
      }

      try {
        const contents = await source.read(request.params.uri);
        return { contents: contents.map(toWireContents) };
      } catch (err) {
        if (isResourceNotFound(err)) throw notFound(request.params.uri);
        throw err;
      }
    },
  );

  // ─────────── resources/subscribe + unsubscribe ───────────
  // Per-connection interest set. `resources/subscribe` binds a listener
  // that fans `notifications/resources/updated`; unsubscribe (or
  // connection close) tears it down.
  const perUriUnsub = new Map<string, Unsubscribe>();

  sdkServer.setRequestHandler(
    SubscribeRequestSchema,
    async (request: SubscribeRequest): Promise<Record<string, never>> => {
      const baseCtx = options.buildContext();
      await evaluateRequestPipeline(security, baseCtx, {
        type: "resource_read",
        name: request.params.uri,
      });
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
  );

  sdkServer.setRequestHandler(
    UnsubscribeRequestSchema,
    async (request: UnsubscribeRequest): Promise<Record<string, never>> => {
      const baseCtx = options.buildContext();
      await evaluateRequestPipeline(security, baseCtx, {
        type: "resource_read",
        name: request.params.uri,
      });
      const unsub = perUriUnsub.get(request.params.uri);
      if (unsub) {
        unsub();
        perUriUnsub.delete(request.params.uri);
      }
      return {};
    },
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

/** Convert a v2 `ResourceDescriptor` to the MCP wire `Resource` shape. */
export function toWireResource(descriptor: ResourceDescriptor): McpWireResource {
  const wire: McpWireResource = { uri: descriptor.uri, name: descriptor.name };
  if (descriptor.description !== undefined) wire.description = descriptor.description;
  if (descriptor.mimeType !== undefined) wire.mimeType = descriptor.mimeType;
  if (descriptor.size !== undefined) wire.size = descriptor.size;
  if (descriptor.title !== undefined) wire.title = descriptor.title;
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
  if (descriptor.title !== undefined) wire.title = descriptor.title;
  return wire;
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
  uri: string,
): Promise<boolean> {
  let cursor: string | undefined;
  do {
    const page = await source.list(cursor);
    const match = page.resources.find((r) => r.uri === uri);
    if (match) return filter(match, ctx);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  // Not a fixed resource — templated or unknown; let the harness decide.
  return true;
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
