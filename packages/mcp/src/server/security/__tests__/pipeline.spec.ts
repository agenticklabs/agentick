import { describe, it, expect, vi } from "vitest";
import type {
  Authenticator,
  MCPRequestContext,
  OperationInfo,
  ConnectionInfo,
  MCPHandlerExtra,
} from "../../../protocol/types.js";
import {
  resolveSecurityDefaults,
  localOnlyGuard,
  rejectAllAuth,
  allowAllGuard,
  allowAllAuth,
} from "../defaults.js";
import {
  SecurityError,
  evaluateConnectionGuard,
  evaluateRequestPipeline,
  buildRequestContext,
} from "../pipeline.js";

// ============================================================================
// Helpers
// ============================================================================

const mockCtx: MCPRequestContext = {
  user: { id: "user-1", tenantId: "tenant-1" },
};

const mockOperation: OperationInfo = {
  type: "tool_call",
  name: "query",
  sessionId: "session-1",
};

function httpConnection(overrides?: Partial<ConnectionInfo>): ConnectionInfo {
  return {
    transport: "streamable-http",
    origin: "https://example.com",
    remoteAddress: "192.168.1.1",
    headers: {},
    ...overrides,
  };
}

// ============================================================================
// Transport-aware defaults
// ============================================================================

describe("resolveSecurityDefaults", () => {
  it("uses restrictive defaults for HTTP transports", () => {
    const resolved = resolveSecurityDefaults("streamable-http");
    expect(resolved.connectionGuard).toBe(localOnlyGuard);
    expect(resolved.authenticator).toBe(rejectAllAuth);
  });

  it("uses restrictive defaults for SSE transports", () => {
    const resolved = resolveSecurityDefaults("sse");
    expect(resolved.connectionGuard).toBe(localOnlyGuard);
    expect(resolved.authenticator).toBe(rejectAllAuth);
  });

  it("uses permissive defaults for in-process transports", () => {
    const resolved = resolveSecurityDefaults("in-process");
    expect(resolved.connectionGuard).toBe(allowAllGuard);
    expect(resolved.authenticator).toBe(allowAllAuth);
  });

  it("uses permissive defaults for stdio transports", () => {
    const resolved = resolveSecurityDefaults("stdio");
    expect(resolved.connectionGuard).toBe(allowAllGuard);
    expect(resolved.authenticator).toBe(allowAllAuth);
  });

  it("allows consumer overrides", () => {
    const customAuth: Authenticator = async () => ({ authenticated: true });
    const resolved = resolveSecurityDefaults("streamable-http", {
      authenticator: customAuth,
    });
    expect(resolved.authenticator).toBe(customAuth);
    // Other defaults still transport-aware
    expect(resolved.connectionGuard).toBe(localOnlyGuard);
  });
});

// ============================================================================
// Connection guard
// ============================================================================

describe("evaluateConnectionGuard", () => {
  it("skips guard for in-process transport", async () => {
    const guard = vi.fn(async () => false); // would reject
    const security = resolveSecurityDefaults("in-process", {
      connectionGuard: guard,
    });
    const result = await evaluateConnectionGuard(security, {
      transport: "in-process",
    });
    expect(result).toBe(true);
    expect(guard).not.toHaveBeenCalled();
  });

  it("skips guard for stdio transport", async () => {
    const guard = vi.fn(async () => false);
    const security = resolveSecurityDefaults("stdio", {
      connectionGuard: guard,
    });
    const result = await evaluateConnectionGuard(security, {
      transport: "stdio",
    });
    expect(result).toBe(true);
    expect(guard).not.toHaveBeenCalled();
  });

  it("invokes guard for HTTP transport", async () => {
    const guard = vi.fn(async () => true);
    const security = resolveSecurityDefaults("streamable-http", {
      connectionGuard: guard,
    });
    const info = httpConnection();
    await evaluateConnectionGuard(security, info);
    expect(guard).toHaveBeenCalledWith(info);
  });

  it("throws SecurityError(403) when guard rejects", async () => {
    const security = resolveSecurityDefaults("streamable-http", {
      connectionGuard: async () => false,
    });
    await expect(evaluateConnectionGuard(security, httpConnection())).rejects.toThrow(
      SecurityError,
    );

    try {
      await evaluateConnectionGuard(security, httpConnection());
    } catch (e) {
      expect(e).toBeInstanceOf(SecurityError);
      expect((e as SecurityError).code).toBe(403);
    }
  });

  describe("localOnlyGuard", () => {
    it("accepts 127.0.0.1", async () => {
      expect(await localOnlyGuard(httpConnection({ remoteAddress: "127.0.0.1" }))).toBe(true);
    });

    it("accepts ::1", async () => {
      expect(await localOnlyGuard(httpConnection({ remoteAddress: "::1" }))).toBe(true);
    });

    it("accepts ::ffff:127.0.0.1", async () => {
      expect(await localOnlyGuard(httpConnection({ remoteAddress: "::ffff:127.0.0.1" }))).toBe(
        true,
      );
    });

    it("rejects external addresses", async () => {
      expect(await localOnlyGuard(httpConnection({ remoteAddress: "192.168.1.1" }))).toBe(false);
    });
  });
});

// ============================================================================
// Request pipeline — order verification
// ============================================================================

describe("evaluateRequestPipeline", () => {
  it("calls authenticator → authorizer → rateLimiter → inputSanitizer in order", async () => {
    const callOrder: string[] = [];

    const security = resolveSecurityDefaults("in-process", {
      authenticator: async () => {
        callOrder.push("authenticator");
        return { authenticated: true };
      },
      authorizer: async () => {
        callOrder.push("authorizer");
        return { allowed: true };
      },
      rateLimiter: async () => {
        callOrder.push("rateLimiter");
        return { allowed: true };
      },
      inputSanitizer: async (_ctx, _tool, input) => {
        callOrder.push("inputSanitizer");
        return input;
      },
    });

    await evaluateRequestPipeline(security, mockCtx, mockOperation, {
      query: "SELECT 1",
    });

    expect(callOrder).toEqual(["authenticator", "authorizer", "rateLimiter", "inputSanitizer"]);
  });

  // ── Authenticator rejection ──

  it("rejects with 401 when authenticator fails", async () => {
    const security = resolveSecurityDefaults("in-process", {
      authenticator: async () => ({
        authenticated: false,
        reason: "Invalid token",
      }),
    });

    try {
      await evaluateRequestPipeline(security, mockCtx, mockOperation);
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SecurityError);
      expect((e as SecurityError).code).toBe(401);
    }
  });

  it("does not call authorizer when authenticator rejects", async () => {
    const authorizer = vi.fn(async () => ({ allowed: true as const }));
    const security = resolveSecurityDefaults("in-process", {
      authenticator: async () => ({
        authenticated: false,
        reason: "No token",
      }),
      authorizer,
    });

    await evaluateRequestPipeline(security, mockCtx, mockOperation).catch(() => {});
    expect(authorizer).not.toHaveBeenCalled();
  });

  // ── Authorizer rejection ──

  it("rejects with 403 when authorizer denies", async () => {
    const security = resolveSecurityDefaults("in-process", {
      authenticator: async () => ({ authenticated: true }),
      authorizer: async () => ({
        allowed: false,
        reason: "Insufficient role",
      }),
    });

    try {
      await evaluateRequestPipeline(security, mockCtx, mockOperation);
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SecurityError);
      expect((e as SecurityError).code).toBe(403);
    }
  });

  it("does not call rateLimiter when authorizer rejects", async () => {
    const rateLimiter = vi.fn(async () => ({ allowed: true as const }));
    const security = resolveSecurityDefaults("in-process", {
      authorizer: async () => ({
        allowed: false,
        reason: "Denied",
      }),
      rateLimiter,
    });

    await evaluateRequestPipeline(security, mockCtx, mockOperation).catch(() => {});
    expect(rateLimiter).not.toHaveBeenCalled();
  });

  // ── Rate limiter rejection ──

  it("rejects with 429 when rate limiter denies", async () => {
    const security = resolveSecurityDefaults("in-process", {
      rateLimiter: async () => ({ allowed: false, retryAfterMs: 5000 }),
    });

    try {
      await evaluateRequestPipeline(security, mockCtx, mockOperation);
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SecurityError);
      expect((e as SecurityError).code).toBe(429);
      expect((e as SecurityError).retryAfterMs).toBe(5000);
    }
  });

  // ── Input sanitizer ──

  it("passes sanitized input through for tool calls", async () => {
    const security = resolveSecurityDefaults("in-process", {
      inputSanitizer: async (_ctx, _tool, input) => ({
        ...input,
        sanitized: true,
      }),
    });

    const result = await evaluateRequestPipeline(security, mockCtx, mockOperation, {
      query: "SELECT 1",
    });

    expect(result).toEqual({ query: "SELECT 1", sanitized: true });
  });

  it("throws -32602 equivalent when sanitizer rejects", async () => {
    const security = resolveSecurityDefaults("in-process", {
      inputSanitizer: async () => {
        throw new Error("Path traversal detected");
      },
    });

    await expect(
      evaluateRequestPipeline(security, mockCtx, mockOperation, {
        path: "../../etc/passwd",
      }),
    ).rejects.toThrow("Path traversal detected");
  });

  it("skips sanitizer for non-tool operations", async () => {
    const sanitizer = vi.fn(async (_ctx: any, _tool: any, input: any) => input);
    const security = resolveSecurityDefaults("in-process", {
      inputSanitizer: sanitizer,
    });

    const resourceOp: OperationInfo = {
      type: "resource_read",
      name: "db://schema/users",
      sessionId: "session-1",
    };

    await evaluateRequestPipeline(security, mockCtx, resourceOp);
    expect(sanitizer).not.toHaveBeenCalled();
  });

  // ── Context received by pipeline functions ──

  it("passes MCPRequestContext to all pipeline functions", async () => {
    const receivedContexts: MCPRequestContext[] = [];

    const security = resolveSecurityDefaults("in-process", {
      authenticator: async (ctx) => {
        receivedContexts.push(ctx);
        return { authenticated: true };
      },
      authorizer: async (ctx) => {
        receivedContexts.push(ctx);
        return { allowed: true };
      },
      rateLimiter: async (ctx) => {
        receivedContexts.push(ctx);
        return { allowed: true };
      },
      inputSanitizer: async (ctx, _tool, input) => {
        receivedContexts.push(ctx);
        return input;
      },
    });

    await evaluateRequestPipeline(security, mockCtx, mockOperation, {});

    expect(receivedContexts).toHaveLength(4);
    for (const ctx of receivedContexts) {
      expect(ctx.user?.id).toBe("user-1");
      expect(ctx.user?.tenantId).toBe("tenant-1");
    }
  });

  it("passes OperationInfo to authorizer and rateLimiter", async () => {
    const receivedOps: OperationInfo[] = [];

    const security = resolveSecurityDefaults("in-process", {
      authorizer: async (_ctx, op) => {
        receivedOps.push(op);
        return { allowed: true };
      },
      rateLimiter: async (_ctx, op) => {
        receivedOps.push(op);
        return { allowed: true };
      },
    });

    await evaluateRequestPipeline(security, mockCtx, mockOperation);

    expect(receivedOps).toHaveLength(2);
    for (const op of receivedOps) {
      expect(op.type).toBe("tool_call");
      expect(op.name).toBe("query");
      expect(op.sessionId).toBe("session-1");
    }
  });
});

// ============================================================================
// Context building
// ============================================================================

describe("buildRequestContext", () => {
  it("uses contextProvider when provided", async () => {
    const extra = { signal: AbortSignal.timeout(5000) } as MCPHandlerExtra;
    const ctx = await buildRequestContext(extra, async (e) => ({
      user: { id: "from-provider" },
      signal: e.signal,
    }));
    expect(ctx.user?.id).toBe("from-provider");
    expect(ctx.signal).toBe(extra.signal);
  });

  it("returns minimal context when no provider", async () => {
    const extra = { signal: AbortSignal.timeout(5000) } as MCPHandlerExtra;
    const ctx = await buildRequestContext(extra);
    expect(ctx.user).toBeUndefined();
    expect(ctx.signal).toBe(extra.signal);
  });
});
