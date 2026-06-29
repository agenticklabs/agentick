/**
 * Form-mode schema flatness — MCP spec compliance (#271).
 *
 * The MCP `elicitation/create` request schema must be a flat object
 * with primitive properties. The harness rejects non-flat schemas
 * synchronously with `ElicitSchemaTooComplex` BEFORE the request
 * reaches the wire — adopters debug schema issues against a typed
 * exception, not opaque "client refused" wire failures.
 *
 * @verifiedBy `@agentick/elicitation-next/flatness.ts` + MCP spec
 *   2025-11-25 `elicitation/create`
 */

import { describe, expect, it } from "vitest";
import { ElicitSchemaTooComplex } from "@agentick/spec-next";

import { assertFlatSchema, checkFlatSchema } from "../flatness.js";

describe("checkFlatSchema — accepts valid form-mode shapes", () => {
  it("accepts an empty object schema", () => {
    expect(checkFlatSchema({ type: "object", properties: {} })).toEqual([]);
  });

  it("accepts all four primitive property types", () => {
    expect(
      checkFlatSchema({
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "integer" },
          height: { type: "number" },
          subscribed: { type: "boolean" },
        },
      }),
    ).toEqual([]);
  });

  it("accepts a single-select string enum", () => {
    expect(
      checkFlatSchema({
        type: "object",
        properties: {
          color: { type: "string", enum: ["red", "green", "blue"] },
        },
      }),
    ).toEqual([]);
  });

  it("accepts a multi-select array with enum items", () => {
    expect(
      checkFlatSchema({
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
        },
      }),
    ).toEqual([]);
  });

  it("accepts a multi-select array with anyOf-titled items", () => {
    expect(
      checkFlatSchema({
        type: "object",
        properties: {
          roles: {
            type: "array",
            items: {
              anyOf: [
                { const: "admin", title: "Administrator" },
                { const: "viewer", title: "Read-only" },
              ],
            },
          },
        },
      }),
    ).toEqual([]);
  });
});

describe("checkFlatSchema — rejects invalid shapes", () => {
  it("rejects a non-object top-level type", () => {
    const issues = checkFlatSchema({ type: "string" });
    expect(issues.some((i) => i.includes("top-level"))).toBe(true);
  });

  it("rejects a nested object property", () => {
    const issues = checkFlatSchema({
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { inner: { type: "string" } },
        },
      },
    });
    expect(issues.some((i) => i.includes("nested"))).toBe(true);
  });

  it("rejects a free-form string array (no enum / anyOf)", () => {
    const issues = checkFlatSchema({
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
      },
    });
    expect(issues.some((i) => i.includes("enumerate options"))).toBe(true);
  });

  it("rejects an array with missing items", () => {
    const issues = checkFlatSchema({
      type: "object",
      properties: { tags: { type: "array" } },
    });
    expect(issues.some((i) => i.includes("items"))).toBe(true);
  });

  it("rejects an unsupported property type (null)", () => {
    const issues = checkFlatSchema({
      type: "object",
      properties: { x: { type: "null" } },
    });
    expect(issues.some((i) => i.includes("unsupported type"))).toBe(true);
  });

  it("rejects an array of objects", () => {
    const issues = checkFlatSchema({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "object", properties: { a: { type: "string" } } },
        },
      },
    });
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe("assertFlatSchema — throws ElicitSchemaTooComplex", () => {
  it("is a no-op for a valid schema", () => {
    expect(() =>
      assertFlatSchema({ type: "object", properties: { name: { type: "string" } } }),
    ).not.toThrow();
  });

  it("throws ElicitSchemaTooComplex carrying issues + schema", () => {
    const bad = {
      type: "object",
      properties: {
        nested: { type: "object", properties: {} },
        tags: { type: "array", items: { type: "string" } },
      },
    };
    try {
      assertFlatSchema(bad);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ElicitSchemaTooComplex);
      const e = err as ElicitSchemaTooComplex;
      expect(e.issues.length).toBeGreaterThanOrEqual(2);
      expect(e.schema).toBe(bad);
      expect(e.message).toMatch(/not flat per MCP spec/);
    }
  });
});
