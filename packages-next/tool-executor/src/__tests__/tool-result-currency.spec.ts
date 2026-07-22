/**
 * ADR 70 — tool result currency.
 *
 * A handler may return `string | ContentBlock[] | { content, structuredContent?,
 * isError?, metadata? }` (+ the Promise / Effect / TaskHandle wrappers),
 * normalized to ONE internal result at dispatch. `structuredContent` is
 * `outputSchema`-validated and flows to `DispatchResult`; `isError` is the
 * SOFT/domain-error flag (throw stays the HARD-failure path).
 *
 * @see docs/proposals/v2/blueprint/70-tool-result-currency.md
 */

import { describe, expect, it } from "vitest";
import type {
  DispatchInput,
  StandardSchemaV1,
  ToolRegistration,
  ToolResultInput,
} from "@agentick/spec-next";
import { jsonSchema, ToolValidationError } from "@agentick/spec-next";
import { createTestHarness } from "../testing/index.js";

// A dependency-free Standard-Schema that actually validates: accepts an
// object carrying `tempF`, rejects everything else. Exercises the
// executor's outputSchema-validation path without pulling in Zod.
const weatherOutputSchema: StandardSchemaV1 = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (v: unknown) =>
      typeof v === "object" && v !== null && "tempF" in v
        ? { value: v }
        : { issues: [{ message: "expected { tempF: number }" }] },
  },
} as StandardSchemaV1;

function reg(name: string, extra?: Partial<ToolRegistration["declaration"]>): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: name,
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["model", "dispatch"],
      ...extra,
    },
    handlerRef: `h.${name}`,
    binding: { scope: "runtime" },
  };
}

function dispatchOf(name: string): DispatchInput {
  return { toolCallId: `c_${name}`, name, input: {}, context: { via: "dispatch" } };
}

describe("ADR 70 — result currency normalization", () => {
  it("string return → exactly one text block", async () => {
    const { harness } = await createTestHarness({
      tools: [reg("s")],
      handlers: [{ handlerRef: "h.s", handler: async () => "hello world" }],
    });
    const result = await harness.dispatch(dispatchOf("s"));
    expect(result.content).toEqual([{ type: "text", text: "hello world" }]);
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent).toBeUndefined();
  });

  it("bare ContentBlock[] return is behavior-identical (parity)", async () => {
    const blocks = [
      { type: "text" as const, text: "a" },
      { type: "text" as const, text: "b" },
    ];
    const { harness } = await createTestHarness({
      tools: [reg("arr")],
      handlers: [{ handlerRef: "h.arr", handler: async () => blocks }],
    });
    const result = await harness.dispatch(dispatchOf("arr"));
    // Same reference threads through — no re-wrapping, no extra fields.
    expect(result.content).toEqual(blocks);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toBeUndefined();
    expect(result.metadata).toBeUndefined();
  });

  it("envelope round-trips content (string sugar) + structuredContent + isError + metadata", async () => {
    const { harness } = await createTestHarness({
      tools: [reg("env")],
      handlers: [
        {
          handlerRef: "h.env",
          handler: async () => ({
            content: "72F, clear",
            structuredContent: { tempF: 72, condition: "clear" },
            isError: false,
            metadata: { source: "cache" },
          }),
        },
      ],
    });
    const result = await harness.dispatch(dispatchOf("env"));
    expect(result.content).toEqual([{ type: "text", text: "72F, clear" }]);
    expect(result.structuredContent).toEqual({ tempF: 72, condition: "clear" });
    expect(result.isError).toBe(false);
    expect(result.metadata).toEqual({ source: "cache" });
  });
});

describe("ADR 70 — isError (soft) vs throw (hard)", () => {
  it("isError:true from a handler surfaces on DispatchResult.isError; dispatch still RESOLVES", async () => {
    const { harness } = await createTestHarness({
      tools: [reg("soft")],
      handlers: [
        {
          handlerRef: "h.soft",
          handler: async () => ({ content: "file not found", isError: true }),
        },
      ],
    });
    const result = await harness.dispatch(dispatchOf("soft"));
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "file not found" }]);
  });

  it("a thrown handler is a HARD failure — the dispatch REJECTS (distinct from isError)", async () => {
    const { harness } = await createTestHarness({
      tools: [reg("hard")],
      handlers: [
        {
          handlerRef: "h.hard",
          handler: async () => {
            throw new Error("boom");
          },
        },
      ],
    });
    await expect(harness.dispatch(dispatchOf("hard"))).rejects.toBeDefined();
  });
});

describe("ADR 70 — structuredContent × outputSchema validation", () => {
  it("valid structuredContent passes outputSchema validation", async () => {
    const { harness } = await createTestHarness({
      tools: [reg("ok", { outputSchema: weatherOutputSchema })],
      handlers: [
        {
          handlerRef: "h.ok",
          handler: async () => ({ content: "ok", structuredContent: { tempF: 68 } }),
        },
      ],
    });
    const result = await harness.dispatch(dispatchOf("ok"));
    expect(result.structuredContent).toEqual({ tempF: 68 });
  });

  it("invalid structuredContent → typed ToolValidationError (HARD reject)", async () => {
    const { harness } = await createTestHarness({
      tools: [reg("bad", { outputSchema: weatherOutputSchema })],
      handlers: [
        {
          handlerRef: "h.bad",
          handler: async () => ({ content: "ok", structuredContent: { wrong: true } }),
        },
      ],
    });
    await expect(harness.dispatch(dispatchOf("bad"))).rejects.toBeInstanceOf(ToolValidationError);
  });

  it("no structuredContent → outputSchema validation skipped (back-compat)", async () => {
    const { harness } = await createTestHarness({
      tools: [reg("skip", { outputSchema: weatherOutputSchema })],
      handlers: [{ handlerRef: "h.skip", handler: async () => "just text" }],
    });
    const result = await harness.dispatch(dispatchOf("skip"));
    expect(result.content).toEqual([{ type: "text", text: "just text" }]);
    expect(result.structuredContent).toBeUndefined();
  });
});

describe("ADR 70 — provenance is executor-stamped, never handler-declarable", () => {
  it("an envelope smuggling executedBy/durationMs has them IGNORED — the executor stamps its own", async () => {
    // HARD RULE (same spoof rule as the ClientToolAnnotations executedBy
    // exclusion, commit b4c21596): handler-declarable ≠ executor-stamped.
    // `executedBy` / `durationMs` are EXECUTOR-only observability — the
    // `ToolResultEnvelope` type does not declare them (they'd be excess-
    // property errors on a literal), and `normalizeToolResult` reads ONLY
    // content / structuredContent / isError / metadata. A handler that widens
    // through `ToolResultInput` to tack them on cannot poison the result: the
    // extras never reach `DispatchResult`.
    const SMUGGLED_DURATION = 999_999;
    const { harness } = await createTestHarness({
      tools: [reg("spoof")],
      handlers: [
        {
          handlerRef: "h.spoof",
          handler: async () =>
            ({
              content: "ok",
              executedBy: "evil-client",
              durationMs: SMUGGLED_DURATION,
            }) as unknown as ToolResultInput,
        },
      ],
    });
    const result = await harness.dispatch(dispatchOf("spoof"));

    // Executor-authoritative provenance — the smuggled values are gone.
    expect(result.executedBy).toBe("agentick");
    expect(result.durationMs).not.toBe(SMUGGLED_DURATION);
    // The real duration is a genuine measurement (small + non-negative).
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(SMUGGLED_DURATION);
    // Content still normalizes; the spoof keys never leaked onto the result.
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("smuggling executedBy inside envelope.metadata cannot forge the top-level provenance", async () => {
    // `metadata` legitimately threads through to `DispatchResult.metadata`, but
    // it is a SEPARATE field — a nested `metadata.executedBy` never becomes the
    // authoritative top-level `DispatchResult.executedBy`.
    const { harness } = await createTestHarness({
      tools: [reg("meta-spoof")],
      handlers: [
        {
          handlerRef: "h.meta-spoof",
          handler: async () => ({ content: "ok", metadata: { executedBy: "evil-client" } }),
        },
      ],
    });
    const result = await harness.dispatch(dispatchOf("meta-spoof"));
    expect(result.executedBy).toBe("agentick");
    expect(result.metadata).toEqual({ executedBy: "evil-client" });
  });
});

describe("ADR 70 — inference sharpness (anti-plain-object)", () => {
  it("wrong-shape return is a TS error; string/array/envelope are valid", () => {
    // @ts-expect-error — a plain object without `content` is NOT a valid
    // ToolResultInput. ADR 70 rejects plain-object→JsonBlock guessing, so
    // a mistyped return stays a COMPILE error rather than a silent
    // reinterpretation. This @ts-expect-error IS the guard.
    const bad: ToolResultInput = { temp: 72 };
    void bad;

    const asString: ToolResultInput = "ok";
    const asArray: ToolResultInput = [{ type: "text", text: "x" }];
    const asEnvelope: ToolResultInput = { content: "hi", structuredContent: { n: 1 } };
    expect([typeof asString, Array.isArray(asArray), "content" in asEnvelope]).toEqual([
      "string",
      true,
      true,
    ]);
  });
});
