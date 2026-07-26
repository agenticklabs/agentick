/**
 * `ResourcesHarnessProtocol` — a read-projection seam over existing
 * content, NOT a store (ADR 62).
 *
 * A **resource** is a `URI → resolver` binding. The harness holds a
 * registry of those bindings (and `uriTemplate → resolver` bindings for
 * parameterized reads) plus the subscribe / `list_changed` notifier. It
 * owns NO content: a resolver reads from wherever the content already
 * lives (the sandbox fs, a document store, a computed view). `read(uri)`
 * routes to the matching resolver and returns the resolved
 * {@link ResourceContents} — the text/blob union MCP uses.
 *
 * The MCP server trio splits readable context by control:
 *   - tools     = **model**-controlled
 *   - prompts   = **user**-controlled
 *   - resources = **application**-controlled — pulled on demand.
 *
 * The design mirrors MCP's `resources/*` shape so the server projection
 * (`@agentick/mcp/server`) maps the registry onto the wire without
 * translation, exactly as the prompts projection does for
 * {@link PromptsHarnessProtocol}. The harness is front-end-agnostic: the
 * React `<Resource>` component and a dep-less `ctx.resource()` are equal
 * sugar over `register`; both populate the same registry.
 *
 * **Provider / consumer asymmetry.** This is the PROVIDER seam —
 * agentick's own resources projected OUT (agentick-as-MCP-server).
 * Reading an *external* server's resources is a `McpClientHarness`
 * concern (`readResource`, Wave 2); a resolver may wrap such a read
 * (`register("proxy://…", () => client.readResource(uri))`) so the
 * compiler consumes external content through the same interface —
 * composition, not conflation.
 *
 * @see docs/proposals/v2/blueprint/62-resources-harness.md
 */

import type { Effect } from "effect";
import type { ResourceContents } from "../data/content-blocks.js";
import type { SubstrateError } from "../data/errors.js";
import type { ResourcesErrorChannel } from "../errors/harnesses.js";
import type { OperationCtx } from "../data/runtime-context.js";
import type { Unsubscribe } from "./inbox.js";
import type { HarnessFx } from "./middleware.js";

// ============================================================================
// Resolvers — read EXISTING content; the harness stores none
// ============================================================================

/**
 * Runs on `read(uri)` for a fixed-URI binding. Returns the resolved
 * content — one or more {@link ResourceContents} (text or blob). Reads
 * from wherever the content already lives; the harness never duplicates
 * it. May be sync or async.
 *
 * The optional second parameter is the invoking crossing's {@link
 * OperationCtx} (ADR 91 §2) — the trunk (sessionId / opId / `mcp.user`
 * identity) plus the `log` / `trace` / `metrics` / `run` facets. Optional in
 * the SIGNATURE so a resolver declaration stays pure and trivially testable;
 * REQUIRED in the LAW — the framework read path always threads the ctx of the
 * op that invoked `read`. A `knowify://me` resolver reads `ctx?.user` /
 * `ctx?.mcp?.user` to resolve identity-scoped content.
 */
export type ResourceResolver = (
  uri: string,
  ctx?: OperationCtx,
) => readonly ResourceContents[] | Promise<readonly ResourceContents[]>;

/**
 * Runs on `read(uri)` for a URI-template binding. Receives the CONCRETE
 * uri that matched the template (not the template itself), so the
 * resolver can parse its own parameters out of the uri. The optional second
 * parameter is the invoking crossing's {@link OperationCtx} — same contract
 * as {@link ResourceResolver} (optional in signature, threaded by the read
 * path in law).
 */
export type TemplateResolver = (
  uri: string,
  ctx?: OperationCtx,
) => readonly ResourceContents[] | Promise<readonly ResourceContents[]>;

// ============================================================================
// Registration metadata + descriptors
// ============================================================================

/**
 * Optional descriptor metadata supplied alongside a fixed-URI
 * registration. Everything is optional — `name` defaults to the uri
 * when omitted (MCP requires a `name` on the wire).
 */
export interface ResourceMeta {
  /** Human-readable name. Defaults to the uri when omitted. */
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
  /** Byte size hint, if known. */
  readonly size?: number;
  /** Display title (MCP `title`). */
  readonly title?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Optional descriptor metadata for a URI-template registration. */
export interface ResourceTemplateMeta {
  /** Human-readable name. Defaults to the uriTemplate when omitted. */
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly title?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * A projected fixed-resource descriptor — what `list` returns and the
 * MCP `resources/list` projection maps onto the wire `Resource` shape.
 */
export interface ResourceDescriptor {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly title?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * A projected template descriptor — what `listTemplates` returns and the
 * MCP `resources/templates/list` projection maps onto the wire
 * `ResourceTemplate` shape.
 */
export interface ResourceTemplateDescriptor {
  readonly uriTemplate: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly title?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// Read results (pagination first-class — MCP requires cursors)
// ============================================================================

export interface ResourcesListResult {
  readonly resources: readonly ResourceDescriptor[];
  /** Opaque continuation token; absent when the last page was returned. */
  readonly nextCursor?: string;
}

export interface ResourcesListTemplatesResult {
  readonly templates: readonly ResourceTemplateDescriptor[];
  readonly nextCursor?: string;
}

/**
 * Synchronous, unpaginated snapshot of the whole registry — every fixed
 * resource + every template descriptor, in the same sorted order `list`
 * / `listTemplates` page through. The sync-read counterpart to the
 * (async, journaled, paginated) `list` command, mirroring how the
 * timeline harness exposes a sync `read()` alongside its async surface.
 *
 * Used by the compiler-surfacing `resources` default projection (ADR 63)
 * which must fold the catalog into the IR synchronously during render.
 */
export interface ResourcesSnapshot {
  readonly resources: readonly ResourceDescriptor[];
  readonly templates: readonly ResourceTemplateDescriptor[];
}

// ============================================================================
// Declared-command input shapes (ADR 51)
// ============================================================================

/** Payload for `resources:read`. */
export interface ResourcesReadInput {
  readonly uri: string;
}

/** Payload for `resources:list`. */
export interface ResourcesListInput {
  readonly cursor?: string;
}

/** Payload for `resources:listTemplates`. */
export interface ResourcesListTemplatesInput {
  readonly cursor?: string;
}

// ============================================================================
// Async surface — the Effect-canonical twin (`.fx`)
// ============================================================================

/**
 * The resources harness's **canonical** read surface: the composable Effect
 * twins of its three declared read commands (ADR 77, the dual-typed edge).
 * Each method returns the operation Effect un-run, so an in-process caller
 * composes it with `yield*` and stays in ONE fiber tree; the positional
 * Promise methods on {@link ResourcesHarnessProtocol} (`read(uri)`) are the
 * edge facade, `runHarnessProtocol` applied at the boundary.
 *
 * ## Why this is on the PROTOCOL, not just the concrete class
 *
 * A protocol-typed ref must be able to compose in-fiber. The MCP server's
 * resources projection holds `Resources` (the protocol) and runs its reads
 * from INSIDE the `mcp:command:read-resource` crossing operation: going
 * through the Promise facade would re-enter Effect on a fresh ROOT fiber that
 * inherits no FiberRef, which severs the trunk — the read would journal as an
 * orphaned root and the {@link ResourceResolver} would receive a ctx with no
 * connection identity (ADR 92 §Slice A, the residual ADR 91 stop-rule #2).
 * Composing `fx.read` on the crossing's captured runtime keeps the chain
 * connection → crossing → `resources:command:read` → resolver intact. Same
 * rationale as `ExecutorProtocol.fx` for the loop executor.
 *
 * Arity note: these take the declared COMMAND INPUT (`{ uri }`), not the
 * protocol's positional sugar (`read(uri)`) — so this is deliberately NOT a
 * `PromiseView` source for the protocol's read methods; the two surfaces
 * share the command, not a mapped type.
 */
export interface ResourcesFx extends HarnessFx {
  /**
   * Resolve a uri to its content — the Effect twin of
   * {@link ResourcesHarnessProtocol.read}. Runs the matching resolver with
   * the invoking operation's {@link OperationCtx}.
   */
  read(
    input: ResourcesReadInput,
  ): Effect.Effect<readonly ResourceContents[], ResourcesErrorChannel | SubstrateError, never>;
  /** Enumerate fixed-resource descriptors, paginated (Effect twin of `list`). */
  list(
    input: ResourcesListInput,
  ): Effect.Effect<ResourcesListResult, ResourcesErrorChannel | SubstrateError, never>;
  /** Enumerate template descriptors, paginated (Effect twin of `listTemplates`). */
  listTemplates(
    input: ResourcesListTemplatesInput,
  ): Effect.Effect<ResourcesListTemplatesResult, ResourcesErrorChannel | SubstrateError, never>;
}

// ============================================================================
// Protocol
// ============================================================================

/**
 * Adopter-facing alias for {@link ResourcesHarnessProtocol}. Use this in
 * surface APIs (function signatures, slot types) so adopters never have
 * to type "Harness".
 */
export type Resources = ResourcesHarnessProtocol;

export interface ResourcesHarnessProtocol {
  readonly id: string;
  readonly ready: Promise<void>;
  /** Backend discriminator (e.g. `"memory"`). Diagnostic. */
  readonly backend: string;
  /**
   * The Effect-canonical read surface (ADR 77, the dual-typed edge) — the
   * twins an in-fiber caller composes with `yield*`. On the PROTOCOL so a
   * protocol-typed ref (the MCP server's resources projection) can compose
   * without severing the fiber at the Promise facade. See {@link ResourcesFx}.
   */
  readonly fx: ResourcesFx;
  close(): Promise<void>;

  // ─── Registration (bind a URI/template to a resolver) ─────────────
  //
  // Resolvers are REQUIRED function parameters, so these are plain
  // in-process methods, NOT declared commands (ADR 51 §1.2 excludes ops
  // with required function args). Registration is a synchronous map
  // insert → synchronous `Unsubscribe`, mirroring the notifier-based
  // subscribe surfaces below.

  /**
   * Bind a fixed uri to a resolver over EXISTING content. Fires
   * `list_changed`. Fails `ResourceAlreadyRegistered` on collision.
   * The returned `Unsubscribe` removes the binding (also fires
   * `list_changed`).
   */
  register(uri: string, resolver: ResourceResolver, meta?: ResourceMeta): Unsubscribe;
  /**
   * Bind a URI template (RFC 6570-lite — `{var}` matches one path
   * segment, `{+var}` / `{/var}` match across segments) to a resolver.
   * `read(uri)` prefers a fixed match, then the first matching template.
   */
  registerTemplate(
    uriTemplate: string,
    resolver: TemplateResolver,
    meta?: ResourceTemplateMeta,
  ): Unsubscribe;

  // ─── Reads (declared commands — journaled + wire-exposable) ───────

  /** Enumerate fixed-resource descriptors, paginated. */
  list(cursor?: string): Promise<ResourcesListResult>;
  /** Enumerate template descriptors, paginated. */
  listTemplates(cursor?: string): Promise<ResourcesListTemplatesResult>;
  /**
   * Resolve a uri to its content. Fixed match first, then the first
   * matching template. Runs the resolver. Unknown uri →
   * `ResourceNotFound`; a throwing/rejecting resolver →
   * `ResourceResolverFailed`.
   */
  read(uri: string): Promise<readonly ResourceContents[]>;

  // ─── Sync surface ─────────────────────────────────────────────────

  /** True iff a fixed resource with this uri is registered. */
  has(uri: string): boolean;
  /**
   * Synchronous, unpaginated snapshot of the whole registry. Powers the
   * `resources` compiler-surfacing default projection (ADR 63), which
   * folds the catalog into the IR during a synchronous render.
   */
  snapshot(): ResourcesSnapshot;

  // ─── Change stream (notifier-based; plain methods) ───────────────

  /**
   * Subscribe to content-update signals for a specific uri. The
   * listener fires whenever a provider calls `notifyUpdated(uri)`.
   * Powers the MCP `resources/subscribe` → `notifications/resources/updated`
   * projection.
   */
  subscribe(uri: string, listener: () => void): Unsubscribe;
  /**
   * Subscribe to registry-topology changes (register / unregister) — the
   * family-grammar `subscribeAll` (the collection-changed twin of the per-uri
   * {@link subscribe}). Powers the MCP `notifications/resources/list_changed`
   * projection; the MCP `list_changed` vocabulary stays at that projection, not
   * on the adopter handle.
   */
  subscribeAll(listener: () => void): Unsubscribe;
  /**
   * A provider signals that the content backing `uri` changed. Fans to
   * every {@link subscribe} listener for that uri.
   */
  notifyUpdated(uri: string): void;
}

/**
 * Structural type guard for a `Resources` instance. Discriminates the
 * adopter slot (instance vs config object) by the live protocol method
 * surface — mirrors {@link isPromptsInstance}. Test for the instance
 * form before falling through to the config-object form.
 */
export function isResourcesInstance(v: unknown): v is Resources {
  if (v === null || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.register === "function" &&
    typeof obj.registerTemplate === "function" &&
    typeof obj.list === "function" &&
    typeof obj.listTemplates === "function" &&
    typeof obj.read === "function" &&
    typeof obj.snapshot === "function" &&
    typeof obj.subscribe === "function" &&
    typeof obj.subscribeAll === "function" &&
    typeof obj.notifyUpdated === "function"
  );
}
