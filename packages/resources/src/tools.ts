/**
 * Model-facing `resource_*` tools — auto-registered by
 * {@link withResources} (default-on, opt-outable).
 *
 * **The model's window onto application-controlled content.** Resources
 * are pulled on demand (ADR 62): unlike tools (model-controlled) and
 * prompts (user-controlled), a resource is content the *application*
 * exposes and the model READS when it decides it needs it. These two
 * tools are that read surface:
 *
 *   - `resource_list` — enumerate available resources (uri + name +
 *     description + mimeType), paginated via an opaque `cursor`.
 *   - `resource_read` — resolve one uri to its content, returned as
 *     first-class `resource` content blocks (text/blob round-trip, ADR
 *     62 §Resource content block).
 *
 * **Naming: `<harness-noun>_<verb>`** (three-audiences-plan §D). The
 * resources harness owns the `resource` noun; `resource_list` /
 * `resource_read` sort together under it and happen to be the MCP-native
 * verbs the model already reasons about ("reading a resource").
 * Underscore-separated for cross-provider tool-name safety.
 *
 * Both handlers reach the session's single {@link Resources} instance
 * via `ctx.resource` — the same registry the AppHarness wired into
 * `bridges.resources` and that `<Resource>` / `withMCP` populate. When
 * no resources harness is mounted (substrate-stripped fixtures), the
 * handlers degrade honestly (`resource_list` → empty; `resource_read` →
 * a typed "unavailable" text block).
 *
 * @see docs/proposals/v2/blueprint/62-resources-harness.md
 */

import { jsonSchema, toRegistration } from "@agentick/spec";
import type {
  ContentBlock,
  ResourceContents,
  ResourceDescriptor,
  ResourceTemplateDescriptor,
  ToolDeclaration,
  ToolHandler,
  ToolHandlerCtx,
  ToolRegistration,
} from "@agentick/spec";

import { EXTENSION_NAME } from "./extension-name.js";

// ============================================================================
// Tool names
// ============================================================================

export const RESOURCE_LIST = "resource_list";
export const RESOURCE_READ = "resource_read";

/**
 * Handler-ref namespace. Includes the sessionId so cross-session
 * registrations on the shared HandlerResolver don't collide — same
 * pattern as `withMCP` / `withTasks`.
 */
function handlerRefFor(sessionId: string, suffix: string): string {
  return `@agentick/resources:${sessionId}:${suffix}`;
}

// ============================================================================
// Tool declarations
// ============================================================================

function listDeclaration(handlerRef: string): ToolDeclaration {
  return {
    id: RESOURCE_LIST,
    name: RESOURCE_LIST,
    summary: "List what is registered under a resource address.",
    group: ["resources"],
    description:
      "List the resources the application has made available for reading. " +
      "Resources are read-only content (files, config, computed views, data " +
      "surfaced by connected MCP servers) that you pull on demand. Returns " +
      "`{ resources: Array<{ uri, name, description?, mimeType? }>, " +
      "templates?: Array<{ uriTemplate, name, description?, mimeType? }>, " +
      "nextCursor? }`. Pass `cursor` (from a prior `nextCursor`) to page " +
      "through a large catalog. Read a specific resource with `resource_read`.",
    inputSchema: jsonSchema({
      type: "object",
      properties: { cursor: { type: "string" } },
      additionalProperties: false,
    }),
    exposure: ["model", "dispatch"],
    handlerRef,
  };
}

function readDeclaration(handlerRef: string): ToolDeclaration {
  return {
    id: RESOURCE_READ,
    name: RESOURCE_READ,
    summary: "Open a resource by its address and read it whole.",
    group: ["resources"],
    description:
      "Read the content of one resource by its `uri` (discover uris with " +
      "`resource_list`). Returns the resource's content as one or more " +
      "content blocks (text or binary). Fails with a typed error if the uri " +
      "is not a registered resource or its backing content could not be read.",
    inputSchema: jsonSchema({
      type: "object",
      properties: { uri: { type: "string" } },
      required: ["uri"],
      additionalProperties: false,
    }),
    exposure: ["model", "dispatch"],
    handlerRef,
  };
}

// ============================================================================
// Handlers
// ============================================================================

function jsonBlock(payload: unknown): readonly ContentBlock[] {
  return [{ type: "text", text: JSON.stringify(payload) } as ContentBlock];
}

/** Map a resolved `ResourceContents` to a first-class `resource` block. */
function resourceBlock(contents: ResourceContents): ContentBlock {
  return { type: "resource", resource: contents } as ContentBlock;
}

/** Trim a descriptor to the model-facing summary shape. */
function summarizeResource(d: ResourceDescriptor): Record<string, unknown> {
  return {
    uri: d.uri,
    name: d.name,
    ...(d.description !== undefined ? { description: d.description } : {}),
    ...(d.mimeType !== undefined ? { mimeType: d.mimeType } : {}),
  };
}

function summarizeTemplate(d: ResourceTemplateDescriptor): Record<string, unknown> {
  return {
    uriTemplate: d.uriTemplate,
    name: d.name,
    ...(d.description !== undefined ? { description: d.description } : {}),
    ...(d.mimeType !== undefined ? { mimeType: d.mimeType } : {}),
  };
}

const listHandler: ToolHandler = async (input, { ctx }) => {
  const resource = (ctx as ToolHandlerCtx).resource;
  if (resource === undefined) return jsonBlock({ resources: [] });
  const { cursor } = input as { readonly cursor?: string };
  const page = await resource.list(cursor);
  // Templates only surface on the first page — a stable, low-noise
  // convention (they have their own cursor space; the common catalog is
  // fixed uris). Adopters needing full template pagination call the
  // harness's `listTemplates` directly.
  const templates =
    cursor === undefined ? await resource.listTemplates() : { templates: [] as const };
  return jsonBlock({
    resources: page.resources.map(summarizeResource),
    ...(templates.templates.length > 0
      ? { templates: templates.templates.map(summarizeTemplate) }
      : {}),
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
  });
};

const readHandler: ToolHandler = async (input, { ctx }) => {
  const resource = (ctx as ToolHandlerCtx).resource;
  const { uri } = input as { readonly uri: string };
  if (resource === undefined) {
    return jsonBlock({ error: "resources_unavailable", uri });
  }
  // Let the harness's typed errors (ResourceNotFound /
  // ResourceResolverFailed) propagate — the executor surfaces them as a
  // failed dispatch rather than a silent empty read (honest errors, per
  // the DX bar).
  const contents = await resource.read(uri);
  return contents.map(resourceBlock);
};

// ============================================================================
// Bundle
// ============================================================================

export interface ResourcesToolsBundle {
  readonly registrations: readonly ToolRegistration[];
  readonly handlers: ReadonlyArray<{
    readonly handlerRef: string;
    readonly handler: ToolHandler;
  }>;
}

/**
 * Build the `resource_list` + `resource_read` tool registrations + their
 * handlers, scoped to a single session. Returned as a bundle so
 * {@link withResources} registers both surfaces in lockstep — mirrors
 * `buildSessionTasksTools`.
 */
export function buildResourcesTools(sessionId: string): ResourcesToolsBundle {
  const listRef = handlerRefFor(sessionId, "list");
  const readRef = handlerRefFor(sessionId, "read");

  const binding = {
    scope: "extension",
    extensionName: EXTENSION_NAME,
    level: "session",
  } as const;

  return {
    registrations: [
      toRegistration(listDeclaration(listRef), binding),
      toRegistration(readDeclaration(readRef), binding),
    ],
    handlers: [
      { handlerRef: listRef, handler: listHandler },
      { handlerRef: readRef, handler: readHandler },
    ],
  };
}
