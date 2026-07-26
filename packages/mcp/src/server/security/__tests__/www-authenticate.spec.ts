/**
 * RFC 6750 `WWW-Authenticate: Bearer` challenge construction —
 * {@link buildWwwAuthenticate} + the {@link wwwAuthenticateMeta} tool-result
 * helper.
 *
 * Pins the exact challenge strings: this is the SINGLE source of truth the
 * HTTP pre-gate (`writeUnauthorized`) also consumes, so the bare-`Bearer`
 * and `resource_metadata="…"` shapes here must stay byte-identical to what
 * the transport emits on a `401`.
 */

import { describe, expect, it } from "vitest";

import {
  buildWwwAuthenticate,
  wwwAuthenticateMeta,
  WWW_AUTHENTICATE_META_KEY,
} from "../www-authenticate.js";

describe("buildWwwAuthenticate", () => {
  it("emits a bare `Bearer` when given no params (RFC 6750 §3 MUST)", () => {
    expect(buildWwwAuthenticate()).toBe("Bearer");
    expect(buildWwwAuthenticate({})).toBe("Bearer");
  });

  it("emits the resource_metadata param alone (pre-gate parity)", () => {
    expect(
      buildWwwAuthenticate({ resourceMetadataUrl: "https://api.example.com/.well-known/x" }),
    ).toBe('Bearer resource_metadata="https://api.example.com/.well-known/x"');
  });

  it("emits error alone", () => {
    expect(buildWwwAuthenticate({ error: "invalid_token" })).toBe('Bearer error="invalid_token"');
  });

  it("emits scope alone", () => {
    expect(buildWwwAuthenticate({ scope: "mcp:write" })).toBe('Bearer scope="mcp:write"');
  });

  it("orders params error, resource_metadata, scope and comma-joins them", () => {
    expect(
      buildWwwAuthenticate({
        error: "insufficient_scope",
        resourceMetadataUrl: "https://api.example.com/rm",
        scope: "invoices:write",
      }),
    ).toBe(
      'Bearer error="insufficient_scope", resource_metadata="https://api.example.com/rm", scope="invoices:write"',
    );
  });
});

describe("wwwAuthenticateMeta", () => {
  it("wraps the challenge under the `mcp/www_authenticate` _meta key", () => {
    expect(WWW_AUTHENTICATE_META_KEY).toBe("mcp/www_authenticate");
    expect(wwwAuthenticateMeta({ scope: "invoices:write", error: "insufficient_scope" })).toEqual({
      "mcp/www_authenticate": 'Bearer error="insufficient_scope", scope="invoices:write"',
    });
  });

  it("produces a bare-Bearer challenge in the _meta when given no params", () => {
    expect(wwwAuthenticateMeta()).toEqual({ "mcp/www_authenticate": "Bearer" });
  });

  it("is mergeable into a CallToolResult._meta as an opt-in step-up signal", () => {
    const result = {
      content: [{ type: "text" as const, text: "Re-auth required." }],
      isError: true,
      _meta: wwwAuthenticateMeta({
        resourceMetadataUrl: "https://api.example.com/.well-known/oauth-protected-resource",
        scope: "invoices:write",
      }),
    };
    expect(result._meta["mcp/www_authenticate"]).toBe(
      'Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource", scope="invoices:write"',
    );
  });
});
