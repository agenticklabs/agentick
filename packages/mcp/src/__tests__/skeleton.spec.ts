/**
 * Skeleton-commit smoke tests — verify the v1-ported pieces resolve
 * and behave correctly under v2's import paths.
 *
 * Each section maps 1:1 to a chunk in the v1 → v2 port plan:
 *   - protocol/errors  (sanitization + builders)
 *   - protocol/completions (sugar + 100-cap)
 *   - transport/in-memory (linked-pair round-trip)
 *   - oauth/provider + default-provider (interface + pending-auth gate)
 */

import { describe, expect, it } from "vitest";

import {
  COMPLETION_MAX_VALUES,
  ErrorCodes,
  completeDependent,
  completeFromAsync,
  completeFromEnum,
  completeFromList,
  completePrefixMatch,
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

  it("toMCPResult maps text + image blocks; unknown → JSON text", () => {
    const r = toMCPResult({
      content: [
        { type: "text", text: "hi" },
        { type: "image", data: "abc", mediaType: "image/jpeg" },
        { type: "json", data: { x: 1 } },
      ],
    });
    expect(r.content).toHaveLength(3);
    expect(r.content[0]).toEqual({ type: "text", text: "hi" });
    expect(r.content[1]).toEqual({ type: "image", data: "abc", mimeType: "image/jpeg" });
    // Unknown type falls through as JSON text.
    expect((r.content[2] as { type: string; text: string }).type).toBe("text");
    expect((r.content[2] as { type: string; text: string }).text).toContain('"x":1');
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

describe("completion builders", () => {
  const ctx = completionCtx();

  it("completeFromList prefix-filters", async () => {
    const r = await completeFromList(["alpha", "alphabet", "beta"])("alph", ctx);
    expect(r.values).toEqual(["alpha", "alphabet"]);
  });

  it("completeFromList returns full list for empty input", async () => {
    const r = await completeFromList(["a", "b", "c"])("", ctx);
    expect(r.values).toEqual(["a", "b", "c"]);
  });

  it("completeFromEnum works with Zod-shape enums", async () => {
    const Schema = { options: ["red", "green", "blue"] as const };
    const r = await completeFromEnum(Schema)("g", ctx);
    expect(r.values).toEqual(["green"]);
  });

  it("completePrefixMatch lazy-loads and filters", async () => {
    let loaded = 0;
    const handler = completePrefixMatch(async () => {
      loaded += 1;
      return ["foo", "bar", "baz"];
    });
    const r = await handler("ba", ctx);
    expect(r.values).toEqual(["bar", "baz"]);
    expect(loaded).toBe(1);
  });

  it("completeDependent returns empty when required deps are missing", async () => {
    const handler = completeDependent({ requires: ["projectId"] }, () => ["x"]);
    const r = await handler("any", ctx);
    expect(r.values).toEqual([]);
  });

  it("completeDependent passes resolved deps to the loader", async () => {
    const handler = completeDependent({ requires: ["projectId"] }, (_, deps) => [
      `contract-${deps.projectId}`,
    ]);
    const r = await handler("any", completionCtx({ projectId: "p1" }));
    expect(r.values).toEqual(["contract-p1"]);
  });

  it("completeFromAsync supports custom hasMore/total", async () => {
    const handler = completeFromAsync(async () => ({
      values: ["a", "b"],
      total: 100,
      hasMore: true,
    }));
    const r = (await handler("", ctx)) as {
      values: readonly string[];
      total?: number;
      hasMore?: boolean;
    };
    expect(r.values).toEqual(["a", "b"]);
    expect(r.total).toBe(100);
    expect(r.hasMore).toBe(true);
  });

  it("enforces the 100-value cap and sets hasMore", async () => {
    const huge = Array.from({ length: 150 }, (_, i) => `v${i}`);
    const r = (await completeFromList(huge)("", ctx)) as {
      values: readonly string[];
      hasMore?: boolean;
    };
    expect(r.values).toHaveLength(COMPLETION_MAX_VALUES);
    expect(r.hasMore).toBe(true);
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
    const r = await handler("q", requestCtx);
    expect(r.values).toEqual(["q!"]);
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
