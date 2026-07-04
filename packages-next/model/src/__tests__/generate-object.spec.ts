/**
 * `generateObject()` (#184): responseFormat injection, JSON parse,
 * Standard Schema validation, typed errors.
 */

import { describe, expect, it } from "vitest";

import type { ExecutionTarget, StandardSchemaV1 } from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";

import { GenerateObjectError, generateObject } from "../generate-object.js";
import type { LanguageModelAdapter } from "../language-model-adapter.js";

const MESSAGES = [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }];

const TARGET: ExecutionTarget = {
  kind: "language-model",
  provider: "scripted",
  modelId: "scripted-v1",
  capabilities: { supportsJsonSchema: true },
};

/** Serves `text` and records the params buildParams received. */
function scripted(text: string): LanguageModelAdapter<{ text: string }, never> & {
  seenParams: () => unknown;
} {
  let seen: unknown;
  return {
    provider: "scripted",
    target: TARGET,
    seenParams: () => seen,
    buildParams: (input) => {
      seen = input;
      return input;
    },
    call: async () => ({ text }),
    openStream: () => {
      throw new Error("not streaming");
    },
    mapChunk: () => [],
    reconstructRaw: () => ({ text: "" }),
    normalize: (raw) => ({
      specVersion: "2026-05-08",
      output: [{ type: "text", text: raw.text }],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }),
  };
}

/** Minimal Standard Schema with real validation. */
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

describe("generateObject", () => {
  it("injects responseFormat json_schema and returns the validated, typed object", async () => {
    const adapter = scripted('{"name":"Ada","age":36}');
    const { object, result } = await generateObject({
      model: adapter,
      schema: personSchema(),
      schemaName: "person",
      messages: MESSAGES,
    });
    expect(object).toEqual({ name: "Ada", age: 36 });
    expect(result.usage?.totalTokens).toBe(2);
    const params = adapter.seenParams() as {
      parameters: { responseFormat: { type: string; name: string; schema: unknown } };
    };
    expect(params.parameters.responseFormat.type).toBe("json_schema");
    expect(params.parameters.responseFormat.name).toBe("person");
  });

  it("carries a raw jsonSchema() through toJsonSchema into responseFormat", async () => {
    const raw = { type: "object", properties: { ok: { type: "boolean" } } };
    const adapter = scripted('{"ok":true}');
    await generateObject({ model: adapter, schema: jsonSchema(raw), messages: MESSAGES });
    const params = adapter.seenParams() as {
      parameters: { responseFormat: { schema: unknown } };
    };
    expect(params.parameters.responseFormat.schema).toEqual(raw);
  });

  it("throws GenerateObjectError with the raw text on non-JSON output", async () => {
    await expect(
      generateObject({
        model: scripted("I refuse to emit JSON"),
        schema: personSchema(),
        messages: MESSAGES,
      }),
    ).rejects.toMatchObject({
      name: "GenerateObjectError",
      text: "I refuse to emit JSON",
      issues: [],
    });
  });

  it("throws GenerateObjectError with issues on schema violation", async () => {
    const err = await generateObject({
      model: scripted('{"name":"Ada","age":"old"}'),
      schema: personSchema(),
      messages: MESSAGES,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GenerateObjectError);
    expect((err as GenerateObjectError).issues[0]?.message).toContain("expected");
  });
});
