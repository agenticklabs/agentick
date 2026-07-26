/**
 * RFC 6750 `WWW-Authenticate: Bearer` challenge construction — the
 * single source of truth for the challenge string shared by:
 *
 *   - the HTTP transport's `401` pre-gate ({@link ../transports/http.ts})
 *   - the {@link wwwAuthenticateMeta} tool-result `_meta` helper (v1
 *     parity — mid-session step-up auth signalled through a
 *     `CallToolResult`).
 *
 * Both emit the SAME RFC 6750 `Bearer` challenge; the formatting lives
 * here so the two never drift. Nothing here is auto-invoked — the pre-gate
 * calls {@link buildWwwAuthenticate} when a crossing fails; a tool handler
 * opts into {@link wwwAuthenticateMeta} when it wants to trigger step-up.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc6750#section-3
 * @see https://datatracker.ietf.org/doc/html/rfc9728
 */

/**
 * Parameters for an RFC 6750 `Bearer` challenge. All optional — a bare
 * `Bearer` (no params) is a valid challenge (RFC 6750 §3 MUSTs the header
 * on a 401 even when there is nothing further to advertise).
 */
export interface WwwAuthenticateParams {
  /**
   * RFC 9728 `resource_metadata` URL pointing at the protected-resource
   * metadata document, so a client can locate the authorization server.
   */
  readonly resourceMetadataUrl?: string;
  /** Space-delimited scope(s) the operation requires (RFC 6750 `scope`). */
  readonly scope?: string;
  /**
   * RFC 6750 `error` code (`invalid_token`, `insufficient_scope`, ...).
   * Signals WHY the credential was rejected.
   */
  readonly error?: string;
}

/**
 * Build an RFC 6750 `WWW-Authenticate: Bearer …` challenge string.
 *
 * Emits a bare `Bearer` when no params are supplied; otherwise appends
 * the `error`, `resource_metadata`, and `scope` auth-params (in that
 * order) as comma-separated `key="value"` pairs.
 *
 * @example
 *   buildWwwAuthenticate()                                  // "Bearer"
 *   buildWwwAuthenticate({ resourceMetadataUrl: "https://…" })
 *     // 'Bearer resource_metadata="https://…"'
 *   buildWwwAuthenticate({ error: "invalid_token", scope: "mcp:write" })
 *     // 'Bearer error="invalid_token", scope="mcp:write"'
 */
export function buildWwwAuthenticate(params: WwwAuthenticateParams = {}): string {
  const parts: string[] = [];
  if (params.error !== undefined) parts.push(`error="${params.error}"`);
  if (params.resourceMetadataUrl !== undefined) {
    parts.push(`resource_metadata="${params.resourceMetadataUrl}"`);
  }
  if (params.scope !== undefined) parts.push(`scope="${params.scope}"`);
  return parts.length > 0 ? `Bearer ${parts.join(", ")}` : "Bearer";
}

/**
 * The MCP `_meta` key carrying a `WWW-Authenticate` challenge inside a
 * `CallToolResult`. A host that understands it can trigger step-up auth
 * mid-session without tearing the connection down.
 */
export const WWW_AUTHENTICATE_META_KEY = "mcp/www_authenticate" as const;

/**
 * Build the `CallToolResult._meta` fragment carrying an RFC 6750 `Bearer`
 * challenge (v1 parity). Merge the returned object into a tool result's
 * `_meta` to signal that the caller must (re)authenticate — optionally
 * with a per-operation `scope` hint and an `error` code.
 *
 * Opt-in only: nothing auto-invokes this. A tool handler decides when a
 * step-up challenge belongs on its result.
 *
 * @example
 *   return {
 *     content: [{ type: "text", text: "Re-authentication required." }],
 *     isError: true,
 *     _meta: wwwAuthenticateMeta({
 *       resourceMetadataUrl: "https://api.example.com/.well-known/oauth-protected-resource",
 *       scope: "invoices:write",
 *       error: "insufficient_scope",
 *     }),
 *   };
 */
export function wwwAuthenticateMeta(params: WwwAuthenticateParams = {}): {
  readonly [WWW_AUTHENTICATE_META_KEY]: string;
} {
  return { [WWW_AUTHENTICATE_META_KEY]: buildWwwAuthenticate(params) };
}
