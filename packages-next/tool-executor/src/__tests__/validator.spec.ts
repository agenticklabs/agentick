import { describe, expect, it } from "vitest";
import type { StandardSchemaV1 } from "@agentick/spec-next";
import { fromStandardSchema, permissiveValidator } from "../validator.js";

describe("permissiveValidator", () => {
  it("returns { value } unchanged for primitives", async () => {
    expect(await permissiveValidator.validate(42)).toEqual({ value: 42 });
    expect(await permissiveValidator.validate("hello")).toEqual({ value: "hello" });
    expect(await permissiveValidator.validate(null)).toEqual({ value: null });
  });

  it("returns { value } unchanged for objects", async () => {
    const v = { a: 1, nested: { b: 2 } };
    expect(await permissiveValidator.validate(v)).toEqual({ value: v });
  });

  it("never returns issues", async () => {
    const result = await permissiveValidator.validate(undefined);
    expect(result).not.toHaveProperty("issues");
  });
});

describe("fromStandardSchema", () => {
  // Hand-rolled Standard Schema validator that rejects values that
  // aren't `{ q: string }`. Exercises both branches without pulling
  // in zod / valibot.
  const objectWithQ: StandardSchemaV1<unknown, { readonly q: string }> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate(value: unknown) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          return { issues: [{ message: "expected an object" }] };
        }
        const v = value as Record<string, unknown>;
        if (typeof v.q !== "string") {
          return { issues: [{ message: "q must be a string", path: ["q"] }] };
        }
        return { value: { q: v.q } };
      },
    },
  };

  it("forwards success result verbatim", async () => {
    const wrapped = fromStandardSchema(objectWithQ);
    const r = await wrapped.validate({ q: "ok" });
    expect(r).toEqual({ value: { q: "ok" } });
  });

  it("forwards issues verbatim", async () => {
    const wrapped = fromStandardSchema(objectWithQ);
    const r = await wrapped.validate({ q: 42 });
    expect(r).toMatchObject({ issues: [{ message: "q must be a string" }] });
  });

  it("handles async validators (returned Promise)", async () => {
    const asyncSchema: StandardSchemaV1<unknown, string> = {
      "~standard": {
        version: 1,
        vendor: "test-async",
        async validate(value: unknown) {
          await new Promise((r) => setTimeout(r, 1));
          if (typeof value !== "string") {
            return { issues: [{ message: "not a string" }] };
          }
          return { value };
        },
      },
    };
    const wrapped = fromStandardSchema(asyncSchema);
    expect(await wrapped.validate("hi")).toEqual({ value: "hi" });
    expect(await wrapped.validate(7)).toMatchObject({ issues: [{ message: "not a string" }] });
  });
});
