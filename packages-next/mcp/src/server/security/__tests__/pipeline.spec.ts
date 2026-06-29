/**
 * Security pipeline runner + transport-aware defaults + 4 built-in stages.
 *
 * Pins:
 *  - Connection guard: trusted transports skip; untrusted run guard
 *  - Pipeline order: authn → authz → rate-limit → sanitize
 *  - Each stage's rejection produces the correct POJO `_tag`:
 *      McpServerConnectionRejected (guard)
 *      McpServerAuthRejected       (authn)
 *      McpServerAuthzDenied        (authz)
 *      McpServerRateLimited        (rate)
 *  - Transport-aware defaults: stdio/in-memory = allowAll; HTTP/WS = localOnly + rejectAll
 *  - bearerTokenAuth: static map + verify fallback + case-insensitive header lookup
 *  - roleBasedAuthz: pattern specificity, missing rule = deny, empty roles = any-authn
 *  - slidingWindowLimiter: enforces max within window, retryAfterMs on rejection
 *  - allowListGuard: IPv4 CIDR + IPv6 prefix + origin glob
 *
 * Error shape follows v2's POJO `_tag` convention. The
 * `SecurityError extends Error` class that was here briefly has been
 * dropped — every rejection throws a discriminated-union member of
 * `McpServerError` from `@agentick/spec-next`.
 *
 * TODO(error-infra): when the AgentickError class hierarchy lands,
 * these throws become `instanceof McpServerConnectionRejected` etc.
 * while preserving the `_tag` discriminator. Tests will gain
 * `instanceof` assertions alongside the `_tag` matches.
 */

import { describe, expect, it } from "vitest";
import type { McpAuthenticatedUser, McpRequestContext } from "@agentick/spec-next";
import {
  McpServerAuthRejected,
  McpServerAuthzDenied,
  McpServerClosed,
  McpServerConnectionRejected,
  McpServerRateLimited,
} from "@agentick/spec-next";

import {
  allowAllAuth,
  allowAllAuthz,
  allowAllGuard,
  allowAllRateLimit,
  allowListGuard,
  bearerTokenAuth,
  evaluateConnectionGuard,
  evaluateRequestPipeline,
  isMcpSecurityError,
  localOnlyGuard,
  passthroughSanitizer,
  rejectAllAuth,
  resolveSecurity,
  roleBasedAuthz,
  slidingWindowLimiter,
} from "../index.js";
import type { AuthnResult, AuthzResult, RateLimitResult, ResolvedSecurity } from "../index.js";

/**
 * Build a fake `McpRequestContext` (ADR 43-shaped) for security
 * pipeline tests. Top-level wire fields (serverId, connectionId,
 * user, clientInfo, clientCapabilities) live under `mcp:` per
 * ADR 43; this helper accepts a flat overrides object — top-level
 * universal overrides (`signal`, `metadata`) AND nested `mcp:`
 * overrides as a Partial, merged on top of the test defaults.
 */
interface CtxOverrides {
  readonly signal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly mcp?: Partial<import("@agentick/spec-next").McpRequestExtras>;
}

function ctx(overrides: CtxOverrides = {}): McpRequestContext {
  return {
    toolCallId: "tc:test",
    signal: overrides.signal ?? new AbortController().signal,
    setState: () => {},
    emit: () => {},
    task: "auto",
    transport: "mcp",
    mcp: {
      serverId: "srv:test",
      connectionId: "conn:1",
      transportKind: "in-memory",
      connectedAt: 1000,
      user: null,
      clientInfo: null,
      clientCapabilities: null,
      ...(overrides.mcp ?? {}),
    },
    metadata: overrides.metadata ?? {},
  };
}

function security(over: Partial<ResolvedSecurity> = {}): ResolvedSecurity {
  return {
    connectionGuard: allowAllGuard,
    authenticator: allowAllAuth,
    authorizer: allowAllAuthz,
    rateLimiter: allowAllRateLimit,
    inputSanitizer: passthroughSanitizer,
    ...over,
  };
}

describe("evaluateConnectionGuard", () => {
  it("skips guard for stdio transports", async () => {
    const guard = countingFn(async () => false);
    await expect(
      evaluateConnectionGuard(security({ connectionGuard: guard }), { transportKind: "stdio" }),
    ).resolves.toBeUndefined();
    expect(guard.calls).toBe(0);
  });

  it("skips guard for in-memory transports", async () => {
    const guard = countingFn(async () => false);
    await expect(
      evaluateConnectionGuard(security({ connectionGuard: guard }), {
        transportKind: "in-memory",
      }),
    ).resolves.toBeUndefined();
    expect(guard.calls).toBe(0);
  });

  it("runs guard for HTTP transports + accepts on true", async () => {
    await expect(
      evaluateConnectionGuard(security(), { transportKind: "http", remoteAddress: "1.2.3.4" }),
    ).resolves.toBeUndefined();
  });

  it("throws McpServerConnectionRejected when guard rejects", async () => {
    const guard = async () => false;
    await expect(
      evaluateConnectionGuard(security({ connectionGuard: guard }), {
        transportKind: "http",
        remoteAddress: "1.2.3.4",
      }),
    ).rejects.toBeInstanceOf(McpServerConnectionRejected);
  });
});

describe("evaluateRequestPipeline", () => {
  it("runs stages in order: authn → authz → rate → sanitize", async () => {
    const order: string[] = [];
    const result = await evaluateRequestPipeline(
      security({
        authenticator: async () => {
          order.push("authn");
          return { authenticated: true, user: { id: "u1" } };
        },
        authorizer: async () => {
          order.push("authz");
          return { allowed: true };
        },
        rateLimiter: async () => {
          order.push("rate");
          return { allowed: true };
        },
        inputSanitizer: async (_c, _t, input) => {
          order.push("sanitize");
          return { ...input };
        },
      }),
      ctx(),
      { type: "tool_call", name: "search" },
      { q: "hello" },
    );
    expect(order).toEqual(["authn", "authz", "rate", "sanitize"]);
    expect(result.ctx.mcp.user).toEqual({ id: "u1" });
    expect(result.toolInput).toEqual({ q: "hello" });
  });

  it("rejects with McpServerAuthRejected; later stages don't run", async () => {
    let authzCalled = false;
    const err = await evaluateRequestPipeline(
      security({
        authenticator: async (): Promise<AuthnResult> => ({
          authenticated: false,
          reason: "nope",
        }),
        authorizer: async () => {
          authzCalled = true;
          return { allowed: true };
        },
      }),
      ctx(),
      { type: "tool_call", name: "x" },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpServerAuthRejected);
    expect(authzCalled).toBe(false);
  });

  it("rejects with McpServerAuthzDenied on authz failure", async () => {
    const err = await evaluateRequestPipeline(
      security({
        authorizer: async (): Promise<AuthzResult> => ({ allowed: false, reason: "no role" }),
      }),
      ctx(),
      { type: "tool_call", name: "x" },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpServerAuthzDenied);
  });

  it("rejects with McpServerRateLimited + retryAfterMs on rate-limit", async () => {
    const err = await evaluateRequestPipeline(
      security({
        rateLimiter: async (): Promise<RateLimitResult> => ({
          allowed: false,
          retryAfterMs: 5000,
        }),
      }),
      ctx(),
      { type: "tool_call", name: "x" },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpServerRateLimited);
  });

  it("does NOT call sanitizer for non-tool operations", async () => {
    let sanCalled = false;
    await evaluateRequestPipeline(
      security({
        inputSanitizer: async (_c, _t, input) => {
          sanCalled = true;
          return { ...input };
        },
      }),
      ctx(),
      { type: "tool_list" },
    );
    expect(sanCalled).toBe(false);
  });

  it("sanitizes input on tool_call only", async () => {
    const result = await evaluateRequestPipeline(
      security({
        inputSanitizer: async (_c, _t, input) => ({ ...input, _sanitized: true }),
      }),
      ctx(),
      { type: "tool_call", name: "x" },
      { q: "hi" },
    );
    expect(result.toolInput).toEqual({ q: "hi", _sanitized: true });
  });

  it("propagates authn-provided user into authz/rate stages", async () => {
    const seenAuthz: (McpAuthenticatedUser | null)[] = [];
    await evaluateRequestPipeline(
      security({
        authenticator: async () => ({
          authenticated: true,
          user: { id: "u9", roles: ["admin"] },
        }),
        authorizer: async (c) => {
          seenAuthz.push(c.mcp.user);
          return { allowed: true };
        },
      }),
      ctx(),
      { type: "tool_call", name: "x" },
    );
    expect(seenAuthz[0]).toEqual({ id: "u9", roles: ["admin"] });
  });
});

describe("isMcpSecurityError type guard", () => {
  it("recognizes all four security tags", () => {
    expect(isMcpSecurityError(new McpServerConnectionRejected({ reason: "x" }))).toBe(true);
    expect(isMcpSecurityError(new McpServerAuthRejected({ reason: "x" }))).toBe(true);
    expect(isMcpSecurityError(new McpServerAuthzDenied({ reason: "x" }))).toBe(true);
    expect(isMcpSecurityError(new McpServerRateLimited())).toBe(true);
  });

  it("rejects non-security tags + non-objects", () => {
    expect(isMcpSecurityError(new McpServerClosed({ serverId: "x" }))).toBe(false);
    expect(isMcpSecurityError({ _tag: "OtherError" })).toBe(false);
    expect(isMcpSecurityError(null)).toBe(false);
    expect(isMcpSecurityError("string")).toBe(false);
    expect(isMcpSecurityError(new Error("plain"))).toBe(false);
  });
});

describe("resolveSecurity — transport-aware defaults", () => {
  it("trusted-only transports: allowAll across the board", () => {
    const sec = resolveSecurity(undefined, ["stdio"]);
    expect(sec.connectionGuard).toBe(allowAllGuard);
    expect(sec.authenticator).toBe(allowAllAuth);
  });

  it("HTTP transport: localOnly + rejectAll defaults", () => {
    const sec = resolveSecurity(undefined, ["http"]);
    expect(sec.connectionGuard).toBe(localOnlyGuard);
    expect(sec.authenticator).toBe(rejectAllAuth);
  });

  it("Mixed (HTTP + stdio): conservative — uses untrusted defaults", () => {
    const sec = resolveSecurity(undefined, ["stdio", "http"]);
    expect(sec.connectionGuard).toBe(localOnlyGuard);
    expect(sec.authenticator).toBe(rejectAllAuth);
  });

  it("explicit overrides win", () => {
    const customGuard = async () => true;
    const sec = resolveSecurity({ connectionGuard: customGuard }, ["http"]);
    expect(sec.connectionGuard).toBe(customGuard);
    expect(sec.authenticator).toBe(rejectAllAuth);
  });
});

describe("localOnlyGuard", () => {
  it("accepts 127.0.0.1, ::1, ::ffff:127.0.0.1", async () => {
    for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(await localOnlyGuard({ transportKind: "http", remoteAddress: addr })).toBe(true);
    }
  });

  it("rejects non-loopback", async () => {
    expect(await localOnlyGuard({ transportKind: "http", remoteAddress: "10.0.0.1" })).toBe(false);
    expect(await localOnlyGuard({ transportKind: "http" })).toBe(false);
  });
});

describe("bearerTokenAuth", () => {
  it("accepts a static-mapped token (case-insensitive Authorization header)", async () => {
    const stage = bearerTokenAuth({
      tokens: { abc123: { id: "u1" } },
    });
    const result = await stage(ctx({ metadata: { headers: { Authorization: "Bearer abc123" } } }));
    expect(result).toEqual({ authenticated: true, user: { id: "u1" } });

    const lower = await stage(ctx({ metadata: { headers: { authorization: "bearer abc123" } } }));
    expect(lower).toEqual({ authenticated: true, user: { id: "u1" } });
  });

  it("falls through to verify on cache miss", async () => {
    const stage = bearerTokenAuth({
      verify: async (token) => (token === "xyz" ? { id: "uX" } : null),
    });
    const result = await stage(ctx({ metadata: { headers: { Authorization: "Bearer xyz" } } }));
    expect(result).toMatchObject({ authenticated: true, user: { id: "uX" } });
  });

  it("rejects missing Authorization header", async () => {
    const stage = bearerTokenAuth({ tokens: { x: { id: "u1" } } });
    const result = await stage(ctx({ metadata: {} }));
    expect(result).toMatchObject({ authenticated: false });
  });

  it("rejects unknown token (no verify supplied)", async () => {
    const stage = bearerTokenAuth({ tokens: {} });
    const result = await stage(ctx({ metadata: { headers: { Authorization: "Bearer zzz" } } }));
    expect(result).toMatchObject({ authenticated: false, reason: "Invalid token" });
  });
});

describe("roleBasedAuthz", () => {
  it("specificity: exact name beats wildcard name", async () => {
    const stage = roleBasedAuthz({
      rules: {
        "tool_call:secret": ["admin"],
        "tool_call:*": [],
      },
    });
    const cAdmin = ctx({ mcp: { user: { id: "u", roles: ["admin"] } } });
    const cUser = ctx({ mcp: { user: { id: "u", roles: [] } } });
    expect((await stage(cAdmin, { type: "tool_call", name: "secret" })).allowed).toBe(true);
    expect((await stage(cUser, { type: "tool_call", name: "secret" })).allowed).toBe(false);
    expect((await stage(cUser, { type: "tool_call", name: "other" })).allowed).toBe(true);
  });

  it("missing rule = implicit deny", async () => {
    const stage = roleBasedAuthz({ rules: { "tool_call:specific": ["admin"] } });
    const result = await stage(ctx({ mcp: { user: { id: "u" } } }), {
      type: "tool_call",
      name: "other",
    });
    expect(result.allowed).toBe(false);
  });

  it("empty role array = any authenticated user", async () => {
    const stage = roleBasedAuthz({ rules: { "*": [] } });
    expect((await stage(ctx({ mcp: { user: { id: "u" } } }), { type: "tool_list" })).allowed).toBe(
      true,
    );
  });

  it("catch-all `*` rule applies when no specific rule matches", async () => {
    const stage = roleBasedAuthz({
      rules: { "tool_call:specific": ["admin"], "*": ["any-user"] },
    });
    const c = ctx({ mcp: { user: { id: "u", roles: ["any-user"] } } });
    expect((await stage(c, { type: "prompt_list" })).allowed).toBe(true);
  });
});

describe("slidingWindowLimiter", () => {
  it("allows under limit", async () => {
    const stage = slidingWindowLimiter({ windowMs: 1000, max: 3 });
    const c = ctx({ mcp: { user: { id: "u" } } });
    for (let i = 0; i < 3; i++) {
      const result = await stage(c, { type: "tool_call", name: "x" });
      expect(result.allowed).toBe(true);
    }
  });

  it("rejects over limit, returns retryAfterMs", async () => {
    const stage = slidingWindowLimiter({ windowMs: 10_000, max: 1 });
    const c = ctx({ mcp: { user: { id: "u" } } });
    await stage(c, { type: "tool_call", name: "x" });
    const second = await stage(c, { type: "tool_call", name: "x" });
    expect(second.allowed).toBe(false);
    expect((second as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
  });

  it("per-key isolation", async () => {
    const stage = slidingWindowLimiter({ windowMs: 10_000, max: 1 });
    await stage(ctx({ mcp: { user: { id: "u1" } } }), { type: "tool_call", name: "x" });
    const otherUser = await stage(ctx({ mcp: { user: { id: "u2" } } }), {
      type: "tool_call",
      name: "x",
    });
    expect(otherUser.allowed).toBe(true);
  });
});

describe("allowListGuard", () => {
  it("matches IPv4 CIDR", async () => {
    const stage = allowListGuard({ addresses: ["10.0.0.0/8"] });
    expect(await stage({ transportKind: "http", remoteAddress: "10.5.6.7" })).toBe(true);
    expect(await stage({ transportKind: "http", remoteAddress: "11.0.0.1" })).toBe(false);
  });

  it("matches IPv4 exact address", async () => {
    const stage = allowListGuard({ addresses: ["1.2.3.4"] });
    expect(await stage({ transportKind: "http", remoteAddress: "1.2.3.4" })).toBe(true);
    expect(await stage({ transportKind: "http", remoteAddress: "1.2.3.5" })).toBe(false);
  });

  it("matches origin glob", async () => {
    const stage = allowListGuard({ origins: ["https://*.example.com"] });
    expect(
      await stage({
        transportKind: "ws",
        remoteAddress: "1.2.3.4",
        origin: "https://app.example.com",
      }),
    ).toBe(true);
    expect(
      await stage({
        transportKind: "ws",
        remoteAddress: "1.2.3.4",
        origin: "https://evil.com",
      }),
    ).toBe(false);
  });

  it("empty allowlist + empty origins = reject", async () => {
    const stage = allowListGuard({});
    expect(await stage({ transportKind: "http", remoteAddress: "1.2.3.4" })).toBe(false);
  });

  it("mode 'all' requires both lists to match", async () => {
    const stage = allowListGuard({
      addresses: ["1.2.3.4"],
      origins: ["https://example.com"],
      mode: "all",
    });
    expect(
      await stage({
        transportKind: "http",
        remoteAddress: "1.2.3.4",
        origin: "https://example.com",
      }),
    ).toBe(true);
    expect(
      await stage({
        transportKind: "http",
        remoteAddress: "1.2.3.4",
        origin: "https://evil.com",
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------
// TODO(test-helpers): the `countingFn` helper below + `caughtTag`-style
// patterns in other test files should migrate to a shared
// `@agentick/utils-next/testing` export so each test file doesn't roll
// its own. Filed alongside the broader error-infra task — adopters
// writing custom security stages also benefit from a stable testing
// surface.
// ---------------------------------------------------------------------

interface CountingFn<R> {
  (...args: unknown[]): Promise<R>;
  calls: number;
}

function countingFn<R>(impl: () => Promise<R>): CountingFn<R> {
  let calls = 0;
  const fn = (async () => {
    calls++;
    return impl();
  }) as CountingFn<R>;
  Object.defineProperty(fn, "calls", { get: () => calls });
  return fn;
}
