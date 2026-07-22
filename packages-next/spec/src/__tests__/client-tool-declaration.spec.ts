/**
 * `toClientToolRegistration` — the wire-slice → CLIENT-HANDLED registration
 * adapter. Pins the two firewall crossings (JSON-Schema wrap, `handlerRef`
 * omission) the `session/set_client_tools` gateway handler relies on.
 */

import { describe, expect, it } from "vitest";

import { toClientToolRegistration } from "../protocol/tool-executor.js";
import { toJsonSchema } from "../data/standard-schema.js";
import type { ClientToolDeclaration } from "../data/declarations.js";

const INPUT_SCHEMA = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
} as const;

function decl(overrides: Partial<ClientToolDeclaration> = {}): ClientToolDeclaration {
  return {
    name: "get_weather",
    description: "Look up the weather (client-handled).",
    inputSchema: INPUT_SCHEMA,
    ...overrides,
  };
}

describe("toClientToolRegistration", () => {
  it("omits handlerRef → the client-handled discriminator", () => {
    const reg = toClientToolRegistration(decl(), { scope: "session", sessionId: "s1" });
    expect(reg.handlerRef).toBeUndefined();
    expect(reg.declaration.handlerRef).toBeUndefined();
  });

  it("wraps the raw JSON Schema into a StandardSchema that round-trips via toJsonSchema", () => {
    const reg = toClientToolRegistration(decl(), { scope: "session", sessionId: "s1" });
    // The declaration's inputSchema is now a StandardSchemaV1 (not the raw
    // object), but toJsonSchema() recovers the exact wire schema the model sees.
    expect(toJsonSchema(reg.declaration.inputSchema)).toEqual(INPUT_SCHEMA);
  });

  it("derives id from name, exposes to the model, and carries the supplied binding", () => {
    const reg = toClientToolRegistration(decl(), { scope: "session", sessionId: "sess-42" });
    expect(reg.declaration.id).toBe("get_weather");
    expect(reg.declaration.name).toBe("get_weather");
    expect(reg.declaration.exposure).toEqual(["model"]);
    expect(reg.binding).toEqual({ scope: "session", sessionId: "sess-42" });
  });

  it("passes serializable annotations + aliases through", () => {
    const reg = toClientToolRegistration(
      decl({
        aliases: ["weather"],
        annotations: {
          title: "Get Weather",
          requiresResponse: true,
          responseTimeoutMs: 5_000,
          defaultResult: [{ type: "text", text: "unavailable" }],
        },
      }),
      { scope: "session", sessionId: "s1" },
    );
    expect(reg.declaration.aliases).toEqual(["weather"]);
    expect(reg.declaration.annotations?.title).toBe("Get Weather");
    expect(reg.declaration.annotations?.requiresResponse).toBe(true);
    expect(reg.declaration.annotations?.responseTimeoutMs).toBe(5_000);
    expect(reg.declaration.annotations?.defaultResult).toEqual([
      { type: "text", text: "unavailable" },
    ]);
  });

  it("omits optional keys entirely when absent (no undefined noise)", () => {
    const reg = toClientToolRegistration(decl(), { scope: "session", sessionId: "s1" });
    expect("aliases" in reg.declaration).toBe(false);
    expect("annotations" in reg.declaration).toBe(false);
  });

  it("SECURITY: strips a smuggled `executedBy` so a client cannot spoof provenance", () => {
    // `executedBy` is absent from ClientToolAnnotations, but a raw wire payload
    // can smuggle it as an excess property. Simulate that malicious JSON via a
    // cast and confirm the wire fold drops it — a client can never seed
    // provenance onto its registration.
    const smuggled = decl({
      annotations: {
        title: "Legit",
        executedBy: "provider:anthropic",
      } as ClientToolDeclaration["annotations"],
    });
    const reg = toClientToolRegistration(smuggled, { scope: "session", sessionId: "s1" });
    expect(reg.declaration.annotations?.title).toBe("Legit");
    expect("executedBy" in (reg.declaration.annotations ?? {})).toBe(false);
    expect(reg.declaration.annotations?.executedBy).toBeUndefined();
  });
});
