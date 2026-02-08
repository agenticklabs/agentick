/**
 * Custom Methods Tests
 *
 * Tests for Gateway custom method dispatch, guards, and schema validation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { Context, type KernelContext, type UserContext } from "@agentick/kernel";
import {
  method,
  isMethodDefinition,
  METHOD_DEFINITION,
  type MethodDefinition,
  type AuthResult,
} from "../types.js";

// ============================================================================
// method() factory tests
// ============================================================================

describe("method() factory", () => {
  it("should create a method definition with symbol marker", () => {
    const def = method({
      handler: async () => ({ result: true }),
    });

    expect(def[METHOD_DEFINITION]).toBe(true);
    expect(isMethodDefinition(def)).toBe(true);
    expect(typeof def.handler).toBe("function");
  });

  it("should preserve schema in method definition", () => {
    const schema = z.object({
      title: z.string(),
      priority: z.enum(["low", "medium", "high"]).optional(),
    });

    const def = method({
      schema,
      handler: async (params) => params,
    });

    expect(def.schema).toBe(schema);
  });

  it("should preserve roles in method definition", () => {
    const def = method({
      roles: ["admin", "moderator"],
      handler: async () => ({}),
    });

    expect(def.roles).toEqual(["admin", "moderator"]);
  });

  it("should preserve guard function in method definition", () => {
    const guard = (ctx: KernelContext) => ctx.user?.id === "admin";

    const def = method({
      guard,
      handler: async () => ({}),
    });

    expect(def.guard).toBe(guard);
  });

  it("should preserve description in method definition", () => {
    const def = method({
      description: "List all tasks for the current user",
      handler: async () => [],
    });

    expect(def.description).toBe("List all tasks for the current user");
  });
});

// ============================================================================
// isMethodDefinition() tests
// ============================================================================

describe("isMethodDefinition()", () => {
  it("should return true for method definitions", () => {
    const def = method({ handler: async () => ({}) });
    expect(isMethodDefinition(def)).toBe(true);
  });

  it("should return false for plain functions", () => {
    const fn = async () => ({});
    expect(isMethodDefinition(fn)).toBe(false);
  });

  it("should return false for plain objects", () => {
    const obj = { handler: async () => ({}) };
    expect(isMethodDefinition(obj)).toBe(false);
  });

  it("should return false for null", () => {
    expect(isMethodDefinition(null)).toBe(false);
  });

  it("should return false for undefined", () => {
    expect(isMethodDefinition(undefined)).toBe(false);
  });

  it("should return false for primitives", () => {
    expect(isMethodDefinition("string")).toBe(false);
    expect(isMethodDefinition(123)).toBe(false);
    expect(isMethodDefinition(true)).toBe(false);
  });
});

// ============================================================================
// Schema validation behavior
// ============================================================================

describe("method schema validation", () => {
  it("should type-infer params from schema", () => {
    const schema = z.object({
      title: z.string(),
      count: z.number(),
    });

    // This is a compile-time type check - if it compiles, the types work
    const def = method({
      schema,
      handler: async (params) => {
        // TypeScript should infer params.title as string and params.count as number
        const result: { title: string; count: number } = {
          title: params.title,
          count: params.count,
        };
        return result;
      },
    });

    expect(def.schema).toBe(schema);
  });
});

// ============================================================================
// Context integration (unit tests without full Gateway)
// ============================================================================

describe("Context integration", () => {
  it("should allow Context.get() inside handlers", async () => {
    const handler = async () => {
      const ctx = Context.get();
      return { userId: ctx.user?.id };
    };

    const user: UserContext = { id: "user-123", roles: ["user"] };
    const ctx = Context.create({ user });

    const result = await Context.run(ctx, handler);
    expect(result).toEqual({ userId: "user-123" });
  });

  it("should make user roles available in context", async () => {
    const handler = async () => {
      const ctx = Context.get();
      return { roles: ctx.user?.roles };
    };

    const user: UserContext = { id: "admin-1", roles: ["admin", "user"] };
    const ctx = Context.create({ user });

    const result = await Context.run(ctx, handler);
    expect(result).toEqual({ roles: ["admin", "user"] });
  });

  it("should make metadata available in context", async () => {
    const handler = async () => {
      const ctx = Context.get();
      return {
        sessionId: ctx.metadata?.sessionId,
        gatewayId: ctx.metadata?.gatewayId,
      };
    };

    const ctx = Context.create({
      metadata: { sessionId: "sess-1", gatewayId: "gw-1" },
    });

    const result = await Context.run(ctx, handler);
    expect(result).toEqual({ sessionId: "sess-1", gatewayId: "gw-1" });
  });
});

// ============================================================================
// Streaming method behavior
// ============================================================================

describe("streaming methods", () => {
  it("should support async generator handlers", async () => {
    async function* streamingHandler() {
      yield { chunk: 1 };
      yield { chunk: 2 };
      yield { chunk: 3 };
    }

    const chunks: unknown[] = [];
    for await (const chunk of streamingHandler()) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([{ chunk: 1 }, { chunk: 2 }, { chunk: 3 }]);
  });

  it("should allow method() with streaming handler", () => {
    const def = method({
      handler: async function* (params: { limit: number }) {
        for (let i = 0; i < params.limit; i++) {
          yield { index: i };
        }
      },
    });

    expect(isMethodDefinition(def)).toBe(true);
  });
});
