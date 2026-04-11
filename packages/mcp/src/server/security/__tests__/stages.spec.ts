import { describe, it, expect, vi } from "vitest";
import {
  bearerTokenAuth,
  roleBasedAuthz,
  slidingWindowLimiter,
  allowListGuard,
  pathTraversalSanitizer,
} from "../stages.js";
import type { MCPRequestContext, OperationInfo } from "../../../protocol/types.js";

// ============================================================================
// Helpers
// ============================================================================

function ctx(overrides: Partial<MCPRequestContext> = {}): MCPRequestContext {
  return {
    metadata: {},
    ...overrides,
  };
}

function op(type: OperationInfo["type"], name?: string, sessionId = "test-session"): OperationInfo {
  const base: OperationInfo = { type, sessionId };
  if (name !== undefined) base.name = name;
  return base;
}

// ============================================================================
// bearerTokenAuth
// ============================================================================

describe("bearerTokenAuth", () => {
  it("throws if neither tokens nor verify is provided", () => {
    expect(() => bearerTokenAuth({})).toThrow(/at least one/i);
  });

  it("accepts static tokens", async () => {
    const auth = bearerTokenAuth({
      tokens: {
        "secret-123": { id: "alice", roles: ["user"] },
      },
    });

    const c = ctx({
      metadata: { headers: { authorization: "Bearer secret-123" } },
    });
    const result = await auth(c);
    expect(result).toEqual({ authenticated: true });
    expect(c.user).toEqual({ id: "alice", roles: ["user"] });
  });

  it("rejects missing Authorization header", async () => {
    const auth = bearerTokenAuth({ tokens: { t: { id: "u" } } });
    const result = await auth(ctx());
    expect(result).toEqual({ authenticated: false, reason: "Missing Authorization header" });
  });

  it("rejects non-Bearer schemes", async () => {
    const auth = bearerTokenAuth({ tokens: { t: { id: "u" } } });
    const result = await auth(
      ctx({ metadata: { headers: { authorization: "Basic dXNlcjpwYXNz" } } }),
    );
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) expect(result.reason).toMatch(/Bearer/);
  });

  it("rejects empty bearer token", async () => {
    const auth = bearerTokenAuth({ tokens: { t: { id: "u" } } });
    const result = await auth(ctx({ metadata: { headers: { authorization: "Bearer " } } }));
    expect(result.authenticated).toBe(false);
  });

  it("rejects unknown static token", async () => {
    const auth = bearerTokenAuth({ tokens: { known: { id: "u" } } });
    const result = await auth(ctx({ metadata: { headers: { authorization: "Bearer unknown" } } }));
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) expect(result.reason).toBe("Unknown token");
  });

  it("calls verify function for dynamic lookup", async () => {
    const verify = vi.fn(async (token: string) => {
      if (token === "valid") return { id: "bob", roles: ["admin"] };
      return null;
    });
    const auth = bearerTokenAuth({ verify });

    const c = ctx({ metadata: { headers: { authorization: "Bearer valid" } } });
    const result = await auth(c);
    expect(result).toEqual({ authenticated: true });
    expect(c.user).toEqual({ id: "bob", roles: ["admin"] });
    expect(verify).toHaveBeenCalledWith("valid");
  });

  it("rejects when verify returns null", async () => {
    const auth = bearerTokenAuth({ verify: async () => null });
    const result = await auth(ctx({ metadata: { headers: { authorization: "Bearer x" } } }));
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) expect(result.reason).toBe("Token rejected");
  });

  it("rejects when verify throws", async () => {
    const auth = bearerTokenAuth({
      verify: async () => {
        throw new Error("JWT expired");
      },
    });
    const result = await auth(ctx({ metadata: { headers: { authorization: "Bearer x" } } }));
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) expect(result.reason).toBe("Token verification failed");
  });

  it("does case-insensitive header lookup", async () => {
    const auth = bearerTokenAuth({ tokens: { t: { id: "u" } } });
    const result = await auth(ctx({ metadata: { headers: { AUTHORIZATION: "Bearer t" } } }));
    expect(result.authenticated).toBe(true);
  });

  it("handles array-valued headers (picks first)", async () => {
    const auth = bearerTokenAuth({ tokens: { t: { id: "u" } } });
    const result = await auth(
      ctx({ metadata: { headers: { authorization: ["Bearer t", "Bearer other"] } } }),
    );
    expect(result.authenticated).toBe(true);
  });

  it("prefers static tokens over verify for same token", async () => {
    const verify = vi.fn(async () => ({ id: "from-verify" }));
    const auth = bearerTokenAuth({
      tokens: { static: { id: "from-static" } },
      verify,
    });
    const c = ctx({ metadata: { headers: { authorization: "Bearer static" } } });
    await auth(c);
    expect(c.user?.id).toBe("from-static");
    expect(verify).not.toHaveBeenCalled();
  });

  it("uses custom extract when provided", async () => {
    const auth = bearerTokenAuth({
      tokens: { custom: { id: "u" } },
      extract: (c) => c.metadata?.apiKey as string | undefined,
    });
    const result = await auth(ctx({ metadata: { apiKey: "Bearer custom" } }));
    expect(result.authenticated).toBe(true);
  });
});

// ============================================================================
// roleBasedAuthz
// ============================================================================

describe("roleBasedAuthz", () => {
  it("allows specific tool_call rule with matching role", async () => {
    const authz = roleBasedAuthz({
      rules: { "tool_call:admin_reset": ["admin"] },
    });
    const c = ctx({ user: { id: "u", roles: ["admin"] } });
    const result = await authz(c, op("tool_call", "admin_reset"));
    expect(result).toEqual({ allowed: true });
  });

  it("rejects specific rule when role missing", async () => {
    const authz = roleBasedAuthz({
      rules: { "tool_call:admin_reset": ["admin"] },
    });
    const c = ctx({ user: { id: "u", roles: ["user"] } });
    const result = await authz(c, op("tool_call", "admin_reset"));
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain("admin");
  });

  it("falls back to wildcard rule when no specific match", async () => {
    const authz = roleBasedAuthz({
      rules: {
        "tool_call:admin_reset": ["admin"],
        "tool_call:*": ["user", "admin"],
      },
    });
    const c = ctx({ user: { id: "u", roles: ["user"] } });
    const result = await authz(c, op("tool_call", "read_file"));
    expect(result.allowed).toBe(true);
  });

  it("specific rule takes precedence over wildcard", async () => {
    const authz = roleBasedAuthz({
      rules: {
        "tool_call:admin_reset": ["admin"],
        "tool_call:*": ["user", "admin"],
      },
    });
    // User has "user" role. Wildcard would allow, but specific rule requires admin.
    const c = ctx({ user: { id: "u", roles: ["user"] } });
    const result = await authz(c, op("tool_call", "admin_reset"));
    expect(result.allowed).toBe(false);
  });

  it("empty roles array allows any authenticated user", async () => {
    const authz = roleBasedAuthz({
      rules: { "resource_read:*": [] },
    });
    const c = ctx({ user: { id: "u", roles: [] } });
    const result = await authz(c, op("resource_read", "docs://guide"));
    expect(result.allowed).toBe(true);
  });

  it("empty roles rejects unauthenticated user", async () => {
    const authz = roleBasedAuthz({
      rules: { "resource_read:*": [] },
    });
    const result = await authz(ctx(), op("resource_read", "docs://guide"));
    expect(result.allowed).toBe(false);
  });

  it("missing rule is deny by default", async () => {
    const authz = roleBasedAuthz({
      rules: { "tool_call:*": ["user"] },
    });
    const c = ctx({ user: { id: "u", roles: ["user"] } });
    const result = await authz(c, op("resource_read", "docs://guide"));
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/No authorization rule/);
  });

  it("catch-all rule handles unmatched operations", async () => {
    const authz = roleBasedAuthz({
      rules: {
        "tool_call:*": ["user"],
        "*": ["user"],
      },
    });
    const c = ctx({ user: { id: "u", roles: ["user"] } });
    const result = await authz(c, op("resource_read", "anything"));
    expect(result.allowed).toBe(true);
  });

  it("session_create bare type rule matches", async () => {
    const authz = roleBasedAuthz({
      rules: { session_create: [] },
    });
    const c = ctx({ user: { id: "u" } });
    const result = await authz(c, op("session_create"));
    expect(result.allowed).toBe(true);
  });

  it("uses custom getRoles when provided", async () => {
    const authz = roleBasedAuthz({
      rules: { "tool_call:*": ["scope:read"] },
      getRoles: (c) => (c.metadata?.scopes as string[] | undefined) ?? [],
    });
    const c = ctx({ metadata: { scopes: ["scope:read", "scope:write"] } });
    const result = await authz(c, op("tool_call", "search"));
    expect(result.allowed).toBe(true);
  });
});

// ============================================================================
// slidingWindowLimiter
// ============================================================================

describe("slidingWindowLimiter", () => {
  it("validates config", () => {
    expect(() => slidingWindowLimiter({ windowMs: 0, max: 10 })).toThrow(/windowMs/);
    expect(() => slidingWindowLimiter({ windowMs: 1000, max: 0 })).toThrow(/max/);
    expect(() => slidingWindowLimiter({ windowMs: -1, max: 10 })).toThrow(/windowMs/);
  });

  it("allows up to max requests per window", async () => {
    const limiter = slidingWindowLimiter({ windowMs: 60_000, max: 3 });
    const c = ctx({ user: { id: "u" } });

    for (let i = 0; i < 3; i++) {
      const result = await limiter(c, op("tool_call", "search"));
      expect(result).toEqual({ allowed: true });
    }
  });

  it("rejects when window full", async () => {
    const limiter = slidingWindowLimiter({ windowMs: 60_000, max: 2 });
    const c = ctx({ user: { id: "u" } });

    await limiter(c, op("tool_call"));
    await limiter(c, op("tool_call"));
    const result = await limiter(c, op("tool_call"));

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(result.retryAfterMs).toBeLessThanOrEqual(60_000);
    }
  });

  it("separates buckets by key", async () => {
    const limiter = slidingWindowLimiter({ windowMs: 60_000, max: 1 });

    const alice = ctx({ user: { id: "alice" } });
    const bob = ctx({ user: { id: "bob" } });

    await limiter(alice, op("tool_call"));
    const aliceSecond = await limiter(alice, op("tool_call"));
    expect(aliceSecond.allowed).toBe(false);

    const bobFirst = await limiter(bob, op("tool_call"));
    expect(bobFirst.allowed).toBe(true);
  });

  it("separates buckets by operation type in default keyFn", async () => {
    const limiter = slidingWindowLimiter({ windowMs: 60_000, max: 1 });
    const c = ctx({ user: { id: "u" } });

    await limiter(c, op("tool_call"));
    const resourceRead = await limiter(c, op("resource_read"));
    expect(resourceRead.allowed).toBe(true);
  });

  it("respects custom keyFn", async () => {
    const limiter = slidingWindowLimiter({
      windowMs: 60_000,
      max: 1,
      keyFn: (_c, o) => o.name ?? o.type,
    });
    const c = ctx();

    await limiter(c, op("tool_call", "search"));
    const readResult = await limiter(c, op("tool_call", "read"));
    expect(readResult.allowed).toBe(true); // different tool = different bucket

    const searchResult = await limiter(c, op("tool_call", "search"));
    expect(searchResult.allowed).toBe(false); // same tool = same bucket
  });

  it("calls onReject callback when configured", async () => {
    const onReject = vi.fn();
    const limiter = slidingWindowLimiter({
      windowMs: 60_000,
      max: 1,
      onReject,
    });
    const c = ctx({ user: { id: "u" } });

    await limiter(c, op("tool_call"));
    await limiter(c, op("tool_call"));

    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject.mock.calls[0]![0]).toContain("u");
    expect(onReject.mock.calls[0]![1]).toBeGreaterThan(0);
  });

  it("expires old entries as time passes", async () => {
    vi.useFakeTimers();
    try {
      const limiter = slidingWindowLimiter({ windowMs: 1000, max: 2 });
      const c = ctx({ user: { id: "u" } });

      vi.setSystemTime(0);
      await limiter(c, op("tool_call"));
      await limiter(c, op("tool_call"));

      // Full — next should be rejected
      const rejected = await limiter(c, op("tool_call"));
      expect(rejected.allowed).toBe(false);

      // Advance past window
      vi.setSystemTime(1500);
      const allowed = await limiter(c, op("tool_call"));
      expect(allowed.allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ============================================================================
// allowListGuard
// ============================================================================

describe("allowListGuard", () => {
  it("throws if neither origins nor remoteAddresses provided", () => {
    expect(() => allowListGuard({})).toThrow(/at least one/i);
  });

  it("allows exact origin match", async () => {
    const guard = allowListGuard({ origins: ["https://app.example.com"] });
    const ok = await guard({
      origin: "https://app.example.com",
      transport: "streamable-http",
    });
    expect(ok).toBe(true);
  });

  it("rejects non-matching origin", async () => {
    const guard = allowListGuard({ origins: ["https://app.example.com"] });
    const ok = await guard({
      origin: "https://evil.example.com",
      transport: "streamable-http",
    });
    expect(ok).toBe(false);
  });

  it("supports wildcard origin patterns", async () => {
    const guard = allowListGuard({ origins: ["https://*.example.com"] });
    expect(await guard({ origin: "https://app.example.com", transport: "streamable-http" })).toBe(
      true,
    );
    expect(await guard({ origin: "https://api.example.com", transport: "streamable-http" })).toBe(
      true,
    );
    expect(await guard({ origin: "https://example.com", transport: "streamable-http" })).toBe(
      false,
    );
    expect(await guard({ origin: "http://app.example.com", transport: "streamable-http" })).toBe(
      false,
    );
  });

  it("allows IPv4 exact match", async () => {
    const guard = allowListGuard({ remoteAddresses: ["192.168.1.100"] });
    expect(await guard({ remoteAddress: "192.168.1.100", transport: "streamable-http" })).toBe(
      true,
    );
    expect(await guard({ remoteAddress: "192.168.1.101", transport: "streamable-http" })).toBe(
      false,
    );
  });

  it("allows IPv4 CIDR match", async () => {
    const guard = allowListGuard({ remoteAddresses: ["10.0.0.0/8"] });
    expect(await guard({ remoteAddress: "10.0.0.1", transport: "streamable-http" })).toBe(true);
    expect(await guard({ remoteAddress: "10.255.255.255", transport: "streamable-http" })).toBe(
      true,
    );
    expect(await guard({ remoteAddress: "11.0.0.1", transport: "streamable-http" })).toBe(false);
  });

  it("matches /32 CIDR exactly", async () => {
    const guard = allowListGuard({ remoteAddresses: ["192.168.1.100/32"] });
    expect(await guard({ remoteAddress: "192.168.1.100", transport: "streamable-http" })).toBe(
      true,
    );
    expect(await guard({ remoteAddress: "192.168.1.101", transport: "streamable-http" })).toBe(
      false,
    );
  });

  it("allows IPv4-mapped IPv6 loopback", async () => {
    const guard = allowListGuard({ remoteAddresses: ["127.0.0.1"] });
    expect(await guard({ remoteAddress: "::ffff:127.0.0.1", transport: "streamable-http" })).toBe(
      true,
    );
  });

  it("allows IPv6 CIDR match", async () => {
    const guard = allowListGuard({ remoteAddresses: ["fc00::/7"] });
    expect(await guard({ remoteAddress: "fc00::1", transport: "streamable-http" })).toBe(true);
    expect(await guard({ remoteAddress: "fd00::1", transport: "streamable-http" })).toBe(true);
    expect(await guard({ remoteAddress: "2001:db8::1", transport: "streamable-http" })).toBe(false);
  });

  it("either/or: passes if EITHER check passes (default)", async () => {
    const guard = allowListGuard({
      origins: ["https://app.example.com"],
      remoteAddresses: ["10.0.0.0/8"],
    });
    // Origin matches, IP doesn't
    expect(
      await guard({
        origin: "https://app.example.com",
        remoteAddress: "1.2.3.4",
        transport: "streamable-http",
      }),
    ).toBe(true);
    // IP matches, origin doesn't
    expect(
      await guard({
        origin: "https://evil.com",
        remoteAddress: "10.5.5.5",
        transport: "streamable-http",
      }),
    ).toBe(true);
  });

  it("requireBoth: both must pass", async () => {
    const guard = allowListGuard({
      origins: ["https://app.example.com"],
      remoteAddresses: ["10.0.0.0/8"],
      requireBoth: true,
    });
    expect(
      await guard({
        origin: "https://app.example.com",
        remoteAddress: "10.5.5.5",
        transport: "streamable-http",
      }),
    ).toBe(true);
    expect(
      await guard({
        origin: "https://app.example.com",
        remoteAddress: "1.2.3.4",
        transport: "streamable-http",
      }),
    ).toBe(false);
  });

  it("rejects missing origin when origins configured", async () => {
    const guard = allowListGuard({ origins: ["https://app.example.com"] });
    expect(await guard({ transport: "streamable-http" })).toBe(false);
  });
});

// ============================================================================
// pathTraversalSanitizer
// ============================================================================

describe("pathTraversalSanitizer", () => {
  it("passes through safe paths", async () => {
    const sanitizer = pathTraversalSanitizer();
    const result = await sanitizer(ctx(), "read_file", { path: "docs/guide.md" });
    expect(result.path).toBe("docs/guide.md");
  });

  it("auto-detects path-like fields by name", async () => {
    const sanitizer = pathTraversalSanitizer();
    const result = await sanitizer(ctx(), "t", {
      path: "safe/file.txt",
      filename: "another.txt",
      content: "hello",
    });
    expect(result.path).toBe("safe/file.txt");
    expect(result.filename).toBe("another.txt");
    expect(result.content).toBe("hello");
  });

  it("rejects literal .. segments", async () => {
    const sanitizer = pathTraversalSanitizer();
    await expect(sanitizer(ctx(), "read_file", { path: "../etc/passwd" })).rejects.toThrow(
      /traversal/i,
    );
  });

  it("rejects nested .. segments", async () => {
    const sanitizer = pathTraversalSanitizer();
    await expect(sanitizer(ctx(), "read_file", { path: "safe/../../etc/passwd" })).rejects.toThrow(
      /traversal/i,
    );
  });

  it("rejects null byte truncation", async () => {
    const sanitizer = pathTraversalSanitizer();
    await expect(sanitizer(ctx(), "read_file", { path: "safe.txt\0.exe" })).rejects.toThrow(
      /null byte/i,
    );
  });

  it("rejects URL-encoded traversal", async () => {
    const sanitizer = pathTraversalSanitizer();
    await expect(sanitizer(ctx(), "read_file", { path: "%2e%2e/etc/passwd" })).rejects.toThrow(
      /traversal/i,
    );
  });

  it("rejects double-URL-encoded traversal", async () => {
    const sanitizer = pathTraversalSanitizer();
    await expect(sanitizer(ctx(), "read_file", { path: "%252e%252e/etc/passwd" })).rejects.toThrow(
      /traversal/i,
    );
  });

  it("rejects backslash-style Windows traversal", async () => {
    const sanitizer = pathTraversalSanitizer();
    await expect(sanitizer(ctx(), "read_file", { path: "..\\..\\etc\\passwd" })).rejects.toThrow(
      /traversal/i,
    );
  });

  it("strip mode removes .. segments instead of rejecting", async () => {
    const sanitizer = pathTraversalSanitizer({ mode: "strip" });
    const result = await sanitizer(ctx(), "read_file", { path: "safe/../bad" });
    expect(result.path).toBe("bad");
  });

  it("strip mode resolves complex traversal", async () => {
    const sanitizer = pathTraversalSanitizer({ mode: "strip" });
    const result = await sanitizer(ctx(), "read_file", {
      path: "/workspace/a/../b/c",
    });
    expect(result.path).toBe("/workspace/b/c");
  });

  it("allowedRoots: allows paths within root", async () => {
    const sanitizer = pathTraversalSanitizer({
      allowedRoots: ["/workspace/"],
    });
    const result = await sanitizer(ctx(), "read_file", { path: "/workspace/file.txt" });
    expect(result.path).toBe("/workspace/file.txt");
  });

  it("allowedRoots: rejects paths outside root", async () => {
    const sanitizer = pathTraversalSanitizer({
      allowedRoots: ["/workspace/"],
    });
    await expect(sanitizer(ctx(), "read_file", { path: "/etc/passwd" })).rejects.toThrow(
      /outside allowed roots/,
    );
  });

  it("allowedRoots: accepts multiple roots", async () => {
    const sanitizer = pathTraversalSanitizer({
      allowedRoots: ["/workspace/", "/tmp/"],
    });
    expect((await sanitizer(ctx(), "t", { path: "/workspace/a" })).path).toBe("/workspace/a");
    expect((await sanitizer(ctx(), "t", { path: "/tmp/b" })).path).toBe("/tmp/b");
    await expect(sanitizer(ctx(), "t", { path: "/etc/c" })).rejects.toThrow(/outside/i);
  });

  it("explicit fields: only checks listed fields", async () => {
    const sanitizer = pathTraversalSanitizer({ fields: ["source"] });
    // `path` is not in fields list, so it's not checked
    const result = await sanitizer(ctx(), "t", {
      source: "safe",
      path: "../bad/but/unchecked",
    });
    expect(result.source).toBe("safe");
    expect(result.path).toBe("../bad/but/unchecked");
  });

  it("ignores non-string field values", async () => {
    const sanitizer = pathTraversalSanitizer();
    const result = await sanitizer(ctx(), "t", {
      path: 42,
      filename: null,
      dir: undefined,
    });
    expect(result.path).toBe(42);
  });
});
