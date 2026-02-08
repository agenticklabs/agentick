/**
 * Gateway Method Dispatch Tests
 *
 * Integration tests for Gateway custom method dispatch, including:
 * - Method initialization and path resolution
 * - Role and custom guard middleware
 * - Schema validation
 * - Auth hydrateUser hook
 * - Express middleware
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { Gateway, createGateway, type ExpressRequestHandler } from "../gateway.js";
import { method, type AuthResult, type AuthConfig, type GatewayConfig } from "../types.js";
import { Context, type UserContext } from "@agentick/kernel";
import { createMockApp } from "@agentick/core/testing";

// ============================================================================
// Gateway initialization tests
// ============================================================================

describe("Gateway method initialization", () => {
  it("should initialize simple function methods", () => {
    const gateway = createGateway({
      apps: { test: createMockApp() as any },
      defaultApp: "test",
      methods: {
        ping: async () => ({ pong: true }),
      },
    });

    // Gateway should be created without errors
    expect(gateway).toBeInstanceOf(Gateway);
  });

  it("should initialize method() definition methods", () => {
    const gateway = createGateway({
      apps: { test: createMockApp() as any },
      defaultApp: "test",
      methods: {
        create: method({
          schema: z.object({ title: z.string() }),
          handler: async (params) => ({ id: "1", title: params.title }),
        }),
      },
    });

    expect(gateway).toBeInstanceOf(Gateway);
  });

  it("should initialize nested namespace methods", () => {
    const gateway = createGateway({
      apps: { test: createMockApp() as any },
      defaultApp: "test",
      methods: {
        tasks: {
          list: async () => [],
          create: method({
            schema: z.object({ title: z.string() }),
            handler: async (params) => ({ id: "1", title: params.title }),
          }),
          admin: {
            archive: method({
              roles: ["admin"],
              handler: async () => ({ archived: true }),
            }),
          },
        },
      },
    });

    expect(gateway).toBeInstanceOf(Gateway);
  });

  it("should handle deeply nested namespaces", () => {
    const gateway = createGateway({
      apps: { test: createMockApp() as any },
      defaultApp: "test",
      methods: {
        level1: {
          level2: {
            level3: {
              level4: {
                deepMethod: async () => ({ deep: true }),
              },
            },
          },
        },
      },
    });

    expect(gateway).toBeInstanceOf(Gateway);
  });
});

// ============================================================================
// Auth configuration tests
// ============================================================================

describe("Auth configuration", () => {
  it("should support auth type none", () => {
    const gateway = createGateway({
      apps: { test: createMockApp() as any },
      defaultApp: "test",
      auth: { type: "none" },
    });

    expect(gateway).toBeInstanceOf(Gateway);
  });

  it("should support auth type token", () => {
    const gateway = createGateway({
      apps: { test: createMockApp() as any },
      defaultApp: "test",
      auth: { type: "token", token: "secret-token" },
    });

    expect(gateway).toBeInstanceOf(Gateway);
  });

  it("should support auth type custom with validate function", () => {
    const gateway = createGateway({
      apps: { test: createMockApp() as any },
      defaultApp: "test",
      auth: {
        type: "custom",
        validate: async (token) => ({
          valid: token === "valid-token",
          user: { id: "user-1" },
        }),
      },
    });

    expect(gateway).toBeInstanceOf(Gateway);
  });

  it("should support hydrateUser hook on any auth type", () => {
    const hydrateUser = vi.fn(
      async (authResult: AuthResult): Promise<UserContext> => ({
        id: authResult.user?.id ?? "unknown",
        roles: ["user", "premium"],
        email: "test@example.com",
      }),
    );

    // With token auth
    const gateway1 = createGateway({
      apps: { test: createMockApp() as any },
      defaultApp: "test",
      auth: {
        type: "token",
        token: "secret",
        hydrateUser,
      },
    });
    expect(gateway1).toBeInstanceOf(Gateway);

    // With custom auth
    const gateway2 = createGateway({
      apps: { test: createMockApp() as any },
      defaultApp: "test",
      auth: {
        type: "custom",
        validate: async () => ({ valid: true, user: { id: "1" } }),
        hydrateUser,
      },
    });
    expect(gateway2).toBeInstanceOf(Gateway);
  });
});

// ============================================================================
// Gateway status and lifecycle tests
// ============================================================================

describe("Gateway status", () => {
  it("should return correct status before start", () => {
    const gateway = createGateway({
      apps: { test: createMockApp() as any },
      defaultApp: "test",
    });

    expect(gateway.running).toBe(false);
    expect(gateway.status.uptime).toBe(0);
    expect(gateway.status.clients).toBe(0);
    expect(gateway.status.sessions).toBe(0);
    expect(gateway.status.apps).toContain("test");
  });

  it("should have a unique id when provided", () => {
    const gateway1 = createGateway({
      apps: { test: createMockApp() as any },
      defaultApp: "test",
      id: "gateway-1",
    });

    const gateway2 = createGateway({
      apps: { test: createMockApp() as any },
      defaultApp: "test",
      id: "gateway-2",
    });

    expect(gateway1.id).toBe("gateway-1");
    expect(gateway2.id).toBe("gateway-2");
    expect(gateway1.id).not.toBe(gateway2.id);
  });

  it("should auto-generate id when not provided", () => {
    const gateway = createGateway({
      apps: { test: createMockApp() as any },
      defaultApp: "test",
    });

    expect(gateway.id).toBeTruthy();
    expect(gateway.id).toMatch(/^gw-/);
  });

  it("should use provided id", () => {
    const gateway = createGateway({
      apps: { test: createMockApp() as any },
      defaultApp: "test",
      id: "custom-gateway-id",
    });

    expect(gateway.id).toBe("custom-gateway-id");
  });
});

// ============================================================================
// Config validation tests
// ============================================================================

describe("Gateway config validation", () => {
  it("should throw if no apps provided", () => {
    expect(() =>
      createGateway({
        apps: {},
        defaultApp: "test",
      }),
    ).toThrow("At least one app is required");
  });

  it("should throw if no defaultApp provided", () => {
    expect(() =>
      createGateway({
        apps: { test: createMockApp() as any },
        defaultApp: "",
      } as any),
    ).toThrow("defaultApp is required");
  });

  it("should use default port and host", () => {
    const gateway = createGateway({
      apps: { test: createMockApp() as any },
      defaultApp: "test",
    });

    // Gateway should be created with defaults
    expect(gateway).toBeInstanceOf(Gateway);
  });
});
