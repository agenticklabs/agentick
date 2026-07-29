/**
 * `withMCP` resource surfacing (ADR 62 §Provider/consumer asymmetry).
 *
 * A connected MCP server's resources are CONSUMER-side content
 * (`client.readResource`). To let the model / adopter / our own
 * MCP-server projection read them through the ONE session
 * {@link Resources} registry, `withMCP` proxy-registers each remote
 * resource: `register(aliasedUri, () => client.readResource(originalUri))`.
 * The protocol doc shows exactly this shape — composition, not
 * conflation. The harness owns no content; the resolver round-trips to
 * the remote read on demand.
 *
 * ## Alias namespace (trust safety)
 *
 * Every surfaced uri is keyed by the ADOPTER ALIAS — the server's config
 * `serverId`, assigned by whoever wired `withMCP({ servers })`. NEVER the
 * server's self-reported name. A malicious/buggy server that reports a
 * name colliding with another server's alias therefore CANNOT shadow
 * that alias's namespace: the surfaced scheme is derived only from the
 * trusted `serverId`.
 *
 * Convention: `mcp://<alias>/<originalUri>`. The alias is the URI
 * authority — a clear, model-legible namespace — and the original uri
 * (scheme and all) is the path, so the mapping round-trips losslessly.
 * `readResource` is always called with the ORIGINAL uri (the resolver
 * closes over it for fixed resources; strips the alias prefix for
 * templates, whose resolver receives the concrete matched uri).
 *
 * @see docs/proposals/v2/blueprint/62-resources-harness.md
 */

import type { ResourceContents, Resources, Unsubscribe } from "@agentick/spec";
import { omitUndefined } from "@agentick/utils";

import type { McpResourcePage, McpResourceTemplatePage } from "../client/types.js";

/** URI scheme all surfaced remote resources live under. */
const ALIAS_SCHEME = "mcp";

/**
 * Namespace a remote resource uri under an adopter alias:
 * `config://app` + alias `docs` → `mcp://docs/config://app`.
 *
 * An EMPTY alias surfaces the uri verbatim — the opt-out for a first-party server
 * whose uri scheme the adopter owns, and whose own documentation names those uris.
 * Rewriting them makes the model's most reliable source of truth wrong: the server
 * says to read `knowify://me`, the registry holds `mcp://knowify/knowify://me`, and
 * the read misses. (Without this branch an empty alias would mint `mcp:///…`, which
 * is a third uri matching nothing.)
 */
export function aliasResourceUri(alias: string, originalUri: string): string {
  return alias === "" ? originalUri : `${ALIAS_SCHEME}://${alias}/${originalUri}`;
}

/**
 * Recover the original remote uri from an aliased one. Inverse of
 * {@link aliasResourceUri}. Defensive: a uri that doesn't carry this
 * alias's prefix is returned unchanged (the resolver then reads it
 * verbatim rather than throwing).
 */
export function stripResourceAlias(alias: string, aliasedUri: string): string {
  if (alias === "") return aliasedUri;
  const prefix = `${ALIAS_SCHEME}://${alias}/`;
  return aliasedUri.startsWith(prefix) ? aliasedUri.slice(prefix.length) : aliasedUri;
}

/**
 * The minimal structural surface {@link surfaceRemoteResources} needs
 * from a connected client. `McpClientHarness` satisfies it; tests supply
 * lightweight fakes (so the alias-keying invariant is exercised without
 * a live transport).
 */
export interface RemoteResourceClient {
  listResources(cursor?: string): Promise<McpResourcePage>;
  listResourceTemplates(cursor?: string): Promise<McpResourceTemplatePage>;
  readResource(uri: string): Promise<readonly ResourceContents[]>;
}

/**
 * Discover one server's resources + templates and proxy-register them
 * into the session {@link Resources} harness under the adopter alias.
 * Drains all cursor pages. Returns the `Unsubscribe[]` for every
 * registration so the caller can tear down on close / before
 * re-discovery.
 *
 * Robust per-item: a single `register` collision (a server advertising a
 * uri twice) is swallowed so it can't abort the rest of the surfacing.
 * Discovery-call failures (server doesn't support resources) propagate
 * to the caller, which treats them as non-fatal (matching tool
 * discovery).
 */
export async function surfaceRemoteResources(
  resources: Resources,
  alias: string,
  client: RemoteResourceClient,
): Promise<readonly Unsubscribe[]> {
  const unsubs: Unsubscribe[] = [];

  // Fixed resources — drain pages.
  let cursor: string | undefined;
  do {
    const page = await client.listResources(cursor);
    for (const r of page.resources) {
      const aliased = aliasResourceUri(alias, r.uri);
      const meta = omitUndefined({
        name: `${alias}: ${r.name}`,
        description: r.description,
        mimeType: r.mimeType,
        size: r.size,
        title: r.title,
      });
      // Proxy resolver closes over the ORIGINAL uri — the surfaced uri
      // is aliased, the remote read is verbatim.
      try {
        unsubs.push(resources.register(aliased, () => client.readResource(r.uri), meta));
      } catch {
        // Duplicate within this server's own advertised list — skip;
        // the first registration wins.
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  // Templates — drain pages.
  let tCursor: string | undefined;
  do {
    const page = await client.listResourceTemplates(tCursor);
    for (const t of page.templates) {
      const aliasedTemplate = aliasResourceUri(alias, t.uriTemplate);
      const meta = omitUndefined({
        name: `${alias}: ${t.name}`,
        description: t.description,
        mimeType: t.mimeType,
        title: t.title,
      });
      try {
        unsubs.push(
          resources.registerTemplate(
            aliasedTemplate,
            // The template resolver receives the CONCRETE matched
            // (aliased) uri; strip the alias prefix to recover the
            // original the remote server understands.
            (concreteUri: string) => client.readResource(stripResourceAlias(alias, concreteUri)),
            meta,
          ),
        );
      } catch {
        // skip duplicate template registration
      }
    }
    tCursor = page.nextCursor;
  } while (tCursor !== undefined);

  return unsubs;
}
