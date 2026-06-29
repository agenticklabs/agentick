/**
 * Integration: `ElicitationHarness.elicit({mode: "form"})` throws
 * `ElicitSchemaTooComplex` synchronously when the schema fails
 * flatness — bad schemas never reach the wire.
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime-next";
import { ElicitSchemaTooComplex, jsonSchema, type StandardSchemaV1 } from "@agentick/spec-next";

import { ElicitationHarness } from "../harness.js";

async function makeHarness(): Promise<ElicitationHarness> {
  const h = new ElicitationHarness(
    `el:${ulid()}`,
    new MemoryJournal({ capacity: 64 }),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await h.ready;
  return h;
}

describe("ElicitationHarness — flatness validation at the wire boundary", () => {
  it("rejects a nested-object schema with ElicitSchemaTooComplex", async () => {
    const h = await makeHarness();
    const nestedSchema = jsonSchema({
      type: "object",
      properties: {
        address: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
    }) as StandardSchemaV1;
    await expect(
      h.elicit({ mode: "form", message: "fill", schema: nestedSchema }, { timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(ElicitSchemaTooComplex);
    await h.close();
  });

  it("rejects a free-form string array with ElicitSchemaTooComplex", async () => {
    const h = await makeHarness();
    const arraySchema = jsonSchema({
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
    }) as StandardSchemaV1;
    await expect(
      h.elicit({ mode: "form", message: "fill", schema: arraySchema }, { timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(ElicitSchemaTooComplex);
    await h.close();
  });

  it("accepts a primitives-only schema (no throw at validation)", async () => {
    const h = await makeHarness();
    const goodSchema = jsonSchema({
      type: "object",
      properties: { name: { type: "string" }, age: { type: "integer" } },
    }) as StandardSchemaV1;
    // No client is wired, so the elicit eventually times out / fails —
    // the point of this test is ONLY that flatness validation does
    // not preempt the wire request. Inspect the rejection:
    // ElicitSchemaTooComplex would mean we wrongly rejected.
    const promise = h.elicit(
      { mode: "form", message: "fill", schema: goodSchema },
      { timeoutMs: 50 },
    );
    const result = await promise;
    expect(result.outcome).toBe("failed");
    // Confirm we got past flatness — not an ElicitSchemaTooComplex.
    if (result.outcome === "failed") {
      expect(result.failure.kind).not.toBe("schema_violation");
    }
    await h.close();
  });
});
