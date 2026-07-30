/**
 * Skeleton-commit smoke tests — verify the v1-ported pieces resolve
 * and behave correctly under v2's import paths.
 *
 * Each section maps 1:1 to a chunk in the v1 → v2 port plan:
 *   - protocol/errors  (sanitization + builders)
 *   - protocol/completions (the re-exported sugar; the cap is the wire's now)
 *   - transport/in-memory (linked-pair round-trip)
 *   - oauth/provider + default-provider (interface + pending-auth gate)
 */

import { describe, expect, it } from "vitest";

import {
  ErrorCodes,
  completeDependent,
  completeFromAsync,
  completeFromEnum,
  completeFromList,
  completePrefixMatch,
  normalizeCompletionResult,
  protocolError,
  sanitizeErrorMessage,
  stripMcpErrorPrefix,
  toMCPResult,
  toolError,
  toolResult,
  InMemoryMcpTransport,
} from "../index.js";

import { DefaultOAuthProvider } from "../oauth/index.js";
import { deriveTestContext } from "@agentick/runtime/testing";
import type { CompletionContext } from "../protocol/completions.js";

/**
 * A full {@link CompletionContext} for the builder tests (ADR 91 §2 —
 * `CompletionContext extends OperationCtx`): the trunk+facets from
 * `deriveTestContext` plus the sibling-argument map the builders read.
 */
const completionCtx = (
  resolvedArguments: Readonly<Record<string, string>> = {},
): CompletionContext => ({ ...deriveTestContext(), resolvedArguments });

// ---------------------------------------------------------------------------
// protocol/errors
// ---------------------------------------------------------------------------

describe("sanitizeErrorMessage", () => {
  it("strips stack trace lines", () => {
    expect(sanitizeErrorMessage("Boom at handler (/foo/bar.ts:12:5) further detail")).toBe(
      "Internal server error",
    );
  });

  it("strips file paths with line numbers", () => {
    expect(sanitizeErrorMessage("/Users/ryan/work/app.ts:42 unexpected token")).toBe(
      "Internal server error",
    );
  });

  it("strips DB connection strings", () => {
    expect(sanitizeErrorMessage("failed to connect to postgres://user:pw@host/db")).toBe(
      "Internal server error",
    );
  });

  it("strips password=... patterns", () => {
    expect(sanitizeErrorMessage("config password=hunter2 was rejected")).toBe(
      "Internal server error",
    );
  });

  it("strips token=/secret=/key= patterns", () => {
    expect(sanitizeErrorMessage("expired token=abc123xyz")).toBe("Internal server error");
    expect(sanitizeErrorMessage("missing api_key=zzz")).toBe("Internal server error");
  });

  it("passes through clean messages verbatim", () => {
    expect(sanitizeErrorMessage("Tool name is required")).toBe("Tool name is required");
  });

  it("honors a custom fallback", () => {
    expect(sanitizeErrorMessage("at boom (/x.ts:1:1) leak", "operation failed")).toBe(
      "operation failed",
    );
  });
});

describe("toolError / toolResult / toMCPResult", () => {
  it("toolError sets isError + sanitizes", () => {
    const r = toolError("dies at handler (/foo/bar.ts:1:1)");
    expect(r.isError).toBe(true);
    expect((r.content[0] as { type: string; text: string }).text).toBe("Internal server error");
  });

  it("toolResult returns a text content block, no isError", () => {
    const r = toolResult("ok");
    expect(r.isError).toBeUndefined();
    expect((r.content[0] as { text: string }).text).toBe("ok");
  });

  it("toMCPResult narrows the agentick union onto the wire (via toWireContent)", () => {
    const r = toMCPResult({
      content: [
        { type: "text", text: "hi" },
        { type: "image", source: { type: "base64", data: "abc", mimeType: "image/jpeg" } },
        { type: "json", data: { x: 1 } },
      ],
    });
    expect(r.content).toHaveLength(3);
    expect(r.content[0]).toEqual({ type: "text", text: "hi" });
    expect(r.content[1]).toEqual({ type: "image", data: "abc", mimeType: "image/jpeg" });
    // No wire kind for `json` — fenced text naming what was projected.
    expect((r.content[2] as { type: string; text: string }).type).toBe("text");
    expect((r.content[2] as { type: string; text: string }).text).toBe('```json\n{"x":1}\n```');
  });
});

describe("protocolError + stripMcpErrorPrefix", () => {
  it("protocolError throws a plain Error with code + data", () => {
    try {
      protocolError(ErrorCodes.METHOD_NOT_FOUND, "missing", { hint: "x" });
      throw new Error("should not reach");
    } catch (e) {
      const err = e as Error & { code: number; data?: unknown };
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(ErrorCodes.METHOD_NOT_FOUND);
      expect(err.message).toBe("missing");
      expect(err.data).toEqual({ hint: "x" });
    }
  });

  it("stripMcpErrorPrefix removes the SDK's prefix when present", () => {
    expect(stripMcpErrorPrefix("MCP error -32601: thing")).toBe("thing");
    expect(stripMcpErrorPrefix("MCP error 0: zero")).toBe("zero");
  });

  it("stripMcpErrorPrefix leaves clean messages alone", () => {
    expect(stripMcpErrorPrefix("no prefix here")).toBe("no prefix here");
  });
});

// ---------------------------------------------------------------------------
// protocol/completions
// ---------------------------------------------------------------------------

describe("completion builders — re-exported from @agentick/completions", () => {
  const ctx = completionCtx();

  // The five builders' own behavior is covered where they LIVE
  // (packages/completions/src/__tests__/builders.spec.ts). What matters here is
  // that mcp's import path still resolves them, that they accept mcp's
  // `CompletionContext`, and that the 100-cap is NO LONGER theirs.

  it("resolve through mcp's barrel and prefix-filter", async () => {
    expect(await completeFromList(["alpha", "alphabet", "beta"])("alph", ctx)).toEqual({
      values: ["alpha", "alphabet"],
    });
    expect(await completeFromEnum({ options: ["red", "green"] })("g", ctx)).toEqual({
      values: ["green"],
    });
    expect(await completePrefixMatch(() => ["foo", "bar"])("ba", ctx)).toEqual({
      values: ["bar"],
    });
    expect(await completeDependent({ requires: ["projectId"] }, () => ["x"])("any", ctx)).toEqual({
      values: [],
    });
  });

  it("no longer cap at 100 — the cap moved to the wire projection", async () => {
    const huge = Array.from({ length: 150 }, (_, i) => `v${i}`);
    const r = normalizeCompletionResult(await completeFromList(huge)("", ctx));
    expect(r.values).toHaveLength(150);
    expect(r.hasMore).toBeUndefined();
  });

  it("ADR 91 §2 — threads the request ctx (trunk + facets) into the handler", async () => {
    let seen: CompletionContext | undefined;
    const handler = completeFromAsync((value, c) => {
      seen = c;
      return [`${value}!`];
    });
    const requestCtx: CompletionContext = {
      ...deriveTestContext({ sessionId: "compl-91" }),
      resolvedArguments: { projectId: "p1" },
    };
    expect(await handler("q", requestCtx)).toEqual({ values: ["q!"] });
    // The handler reads the request's trunk (sessionId) + sibling arguments +
    // the log/run facets off the SAME ctx.
    expect(seen?.sessionId).toBe("compl-91");
    expect(seen?.resolvedArguments).toEqual({ projectId: "p1" });
    expect(typeof seen?.log).toBe("function");
    expect(typeof seen?.run).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// transport/in-memory
// ---------------------------------------------------------------------------

describe("InMemoryMcpTransport", () => {
  it("linked pair: sends from one delivers to the other", async () => {
    const [a, b] = InMemoryMcpTransport.createLinkedPair();
    const seenOnB: unknown[] = [];
    b.onmessage = (msg) => seenOnB.push(msg);
    await b.start();

    await a.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(seenOnB).toHaveLength(1);
    expect(seenOnB[0]).toMatchObject({ method: "ping", id: 1 });

    await a.close();
  });

  it("queues messages until start() if onmessage isn't set yet", async () => {
    const [a, b] = InMemoryMcpTransport.createLinkedPair();
    // a sends BEFORE b.onmessage is registered or b.start() drains queue.
    await a.send({ jsonrpc: "2.0", id: 1, method: "queued" });
    const seenOnB: unknown[] = [];
    b.onmessage = (msg) => seenOnB.push(msg);
    await b.start();
    expect(seenOnB).toHaveLength(1);
    await a.close();
  });

  it("send throws after close", async () => {
    const [a, b] = InMemoryMcpTransport.createLinkedPair();
    await a.close();
    await expect(a.send({ jsonrpc: "2.0", id: 1, method: "x" })).rejects.toThrow(/not connected/i);
    void b;
  });
});

// ---------------------------------------------------------------------------
// oauth/provider + default-provider
// ---------------------------------------------------------------------------

describe("DefaultOAuthProvider", () => {
  it("stores + loads tokens / client info round-trip", async () => {
    const provider = new DefaultOAuthProvider({
      serverName: "test",
      serverUrl: "https://example.invalid",
    });
    expect(await provider.loadTokens()).toBeUndefined();
    expect(await provider.loadClientInfo()).toBeUndefined();

    await provider.saveTokens({ access_token: "tok", token_type: "Bearer" });
    expect(await provider.loadTokens()).toEqual({ access_token: "tok", token_type: "Bearer" });

    await provider.saveClientInfo({
      client_id: "cid",
      redirect_uris: ["http://127.0.0.1:8080/callback"],
    });
    expect((await provider.loadClientInfo())?.client_id).toBe("cid");
  });

  it("redirectToAuthorization gates waitForAuthorizationCode on resolveAuthorizationCode", async () => {
    const provider = new DefaultOAuthProvider({
      serverName: "test",
      serverUrl: "https://example.invalid",
      onAuthorizationNeeded: () => {
        /* swallow the URL */
      },
    });
    await provider.redirectToAuthorization(new URL("https://auth.example/authorize"));
    const codeP = provider.waitForAuthorizationCode();
    provider.resolveAuthorizationCode("code-xyz");
    await expect(codeP).resolves.toBe("code-xyz");
  });

  it("cancelAuthorization resolves the wait with undefined", async () => {
    const provider = new DefaultOAuthProvider({
      serverName: "test",
      serverUrl: "https://example.invalid",
      onAuthorizationNeeded: () => {},
    });
    await provider.redirectToAuthorization(new URL("https://auth.example/authorize"));
    const codeP = provider.waitForAuthorizationCode();
    provider.cancelAuthorization();
    await expect(codeP).resolves.toBeUndefined();
  });

  it("fills sensible default clientMetadata", () => {
    const provider = new DefaultOAuthProvider({
      serverName: "linear",
      serverUrl: "https://mcp.linear.app",
    });
    expect(provider.clientMetadata.client_name).toBe("linear");
    expect(provider.clientMetadata.grant_types).toContain("authorization_code");
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("none");
  });
});
