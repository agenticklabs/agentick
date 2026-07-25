/**
 * `parseJsonWithSchema` — the shared "text → typed value" step for
 * structured model output. Semantics are identical to the historical
 * inline logic in `generateObject` (model/src/generate-object.ts): a JSON
 * parse failure and a schema-validation failure are distinguished by the
 * `reason` discriminator; both return `{ ok: false }` (never throw).
 */

import { describe, expect, it } from "vitest";

import type { StandardSchemaV1 } from "../data/standard-schema.js";
import { parseJsonWithSchema } from "../data/standard-schema.js";

/** Minimal Standard Schema with real validation (mirrors the model spec). */
function personSchema(): StandardSchemaV1<unknown, { name: string; age: number }> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => {
        const v = value as { name?: unknown; age?: unknown };
        if (typeof v?.name === "string" && typeof v?.age === "number") {
          return { value: { name: v.name, age: v.age } };
        }
        return { issues: [{ message: "expected { name: string, age: number }" }] };
      },
    },
  };
}

/** A schema whose validator resolves asynchronously. */
function asyncSchema(): StandardSchemaV1<unknown, { ok: boolean }> {
  return {
    "~standard": {
      version: 1,
      vendor: "test-async",
      validate: async (value) => {
        await Promise.resolve();
        const v = value as { ok?: unknown };
        if (typeof v?.ok === "boolean") return { value: { ok: v.ok } };
        return { issues: [{ message: "expected { ok: boolean }" }] };
      },
    },
  };
}

describe("parseJsonWithSchema", () => {
  it("returns the validated, typed value on success", async () => {
    const result = await parseJsonWithSchema('{"name":"Ada","age":36}', personSchema());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ name: "Ada", age: 36 });
  });

  it("maps a JSON parse failure to reason=invalid-json with empty issues + cause + raw text", async () => {
    const result = await parseJsonWithSchema("I refuse to emit JSON", personSchema());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-json");
      expect(result.issues).toEqual([]);
      expect(result.text).toBe("I refuse to emit JSON");
      expect(result.cause).toBeInstanceOf(SyntaxError);
    }
  });

  it("maps a schema-validation failure to reason=schema with the validator issues + raw text", async () => {
    const result = await parseJsonWithSchema('{"name":"Ada","age":"old"}', personSchema());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("schema");
      expect(result.issues[0]?.message).toContain("expected");
      expect(result.text).toBe('{"name":"Ada","age":"old"}');
      expect(result.cause).toBeUndefined();
    }
  });

  it("awaits an async Standard Schema validator", async () => {
    const ok = await parseJsonWithSchema('{"ok":true}', asyncSchema());
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value).toEqual({ ok: true });

    const bad = await parseJsonWithSchema('{"ok":"nope"}', asyncSchema());
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("schema");
  });
});
