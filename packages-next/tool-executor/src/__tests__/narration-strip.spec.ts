/**
 * Tool-call presentation — model-narration `_summary` strip + resolve
 * (Pass B).
 *
 * The reserved {@link TOOL_NARRATION_FIELD} the projector injects into a
 * model-facing tool schema is STRIPPED from the raw input BEFORE
 * validation, so it never reaches the author schema, the handler, or the
 * persisted `tool_result`. The executor surfaces the display presentation as
 * FOUR distinct fields (`name` / `title` / `summary` / `narration`, never
 * collapsed — the client composes precedence) on `DispatchResult.presentation`.
 *
 * @verifiedBy this suite
 */

import { describe, expect, it } from "vitest";
import type { ToolRegistration, Validator } from "@agentick/spec-next";
import { jsonSchema, TOOL_NARRATION_FIELD } from "@agentick/spec-next";
import { createTestHarness } from "../testing/index.js";

/** Validator that FAILS if `_summary` reaches it — proves the strip is pre-validation. */
const rejectSummary: Validator = {
  validate: (value) => {
    if (value !== null && typeof value === "object" && TOOL_NARRATION_FIELD in value) {
      return { issues: [{ message: "`_summary` leaked into validation" }] };
    }
    return { value };
  },
};

function reg(
  name: string,
  annotations?: ToolRegistration["declaration"]["annotations"],
): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: `the ${name} tool`,
      inputSchema: jsonSchema({ type: "object", properties: { query: { type: "string" } } }),
      exposure: ["model", "dispatch"],
      ...(annotations !== undefined ? { annotations } : {}),
    },
    handlerRef: `h.${name}`,
    binding: { scope: "runtime" },
  };
}

describe("dispatchBody — `_summary` strip (Pass B)", () => {
  it("strips `_summary` BEFORE validation and never passes it to the handler", async () => {
    let received: unknown;
    const { harness } = await createTestHarness({
      tools: [reg("search")],
      handlers: [
        {
          handlerRef: "h.search",
          handler: async (input) => {
            received = input;
            return [{ type: "text", text: "done" }];
          },
          validator: rejectSummary, // throws (soft-fails) if `_summary` survives
        },
      ],
    });

    const result = await harness.dispatch({
      toolCallId: "c1",
      name: "search",
      input: { query: "retry config", [TOOL_NARRATION_FIELD]: "Searching the docs" },
      context: { via: "model" },
    });

    // Validation saw the stripped input (rejectSummary did not fire) → success.
    expect(result.isError).toBeUndefined();
    // Handler never saw `_summary`.
    expect(received).toEqual({ query: "retry config" });
    expect(received as Record<string, unknown>).not.toHaveProperty(TOOL_NARRATION_FIELD);
    // The result content carries no `_summary` either.
    expect(JSON.stringify(result.content)).not.toContain(TOOL_NARRATION_FIELD);
  });

  it("does not mutate the caller's input object (shallow copy)", async () => {
    const { harness } = await createTestHarness({
      tools: [reg("search")],
      handlers: [{ handlerRef: "h.search", handler: async () => [{ type: "text", text: "ok" }] }],
    });
    const callerInput = { query: "x", [TOOL_NARRATION_FIELD]: "narration" };
    await harness.dispatch({
      toolCallId: "c2",
      name: "search",
      input: callerInput,
      context: { via: "model" },
    });
    // The caller's object still has its `_summary` — we copied, never deleted.
    expect(callerInput).toHaveProperty(TOOL_NARRATION_FIELD, "narration");
  });
});

describe("dispatchBody — presentation: four distinct fields (Pass B)", () => {
  async function dispatchWith(
    annotations: ToolRegistration["declaration"]["annotations"],
    input: Record<string, unknown>,
    via: "model" | "dispatch" = "model",
  ) {
    const { harness } = await createTestHarness({
      tools: [reg("mytool", annotations)],
      handlers: [{ handlerRef: "h.mytool", handler: async () => [{ type: "text", text: "ok" }] }],
    });
    return harness.dispatch({
      toolCallId: `c_${Math.random()}`,
      name: "mytool",
      input,
      context: { via },
    });
  }

  it("surfaces name, title, author summary, and model narration as DISTINCT fields (never collapsed)", async () => {
    const result = await dispatchWith(
      { title: "My Tool", displaySummary: "author summary" },
      { query: "x", [TOOL_NARRATION_FIELD]: "model narration" },
    );
    // Four distinct fields — the model narration does NOT overwrite the author
    // summary; the client composes precedence, the framework does not.
    expect(result.presentation).toEqual({
      name: "mytool",
      title: "My Tool",
      summary: "author summary",
      narration: "model narration",
    });
  });

  it("falls to displaySummary (string) when the model supplied no narration", async () => {
    const result = await dispatchWith(
      { title: "My Tool", displaySummary: "author summary" },
      { query: "x" },
    );
    expect(result.presentation?.summary).toBe("author summary");
    expect(result.presentation?.narration).toBeUndefined();
  });

  it("evaluates a per-call displaySummary function against the validated input + ctx", async () => {
    const result = await dispatchWith(
      { displaySummary: (input) => `Searching for ${(input as { query: string }).query}` },
      { query: "widgets" },
    );
    expect(result.presentation?.summary).toBe("Searching for widgets");
  });

  it("title with no summary leaves summary undefined (client falls back to title)", async () => {
    const result = await dispatchWith({ title: "My Tool" }, { query: "x" });
    expect(result.presentation).toEqual({ name: "mytool", title: "My Tool" });
    expect(result.presentation?.summary).toBeUndefined();
  });

  it("nothing set surfaces only name (client falls back to name)", async () => {
    const result = await dispatchWith(undefined, { query: "x" });
    expect(result.presentation).toEqual({ name: "mytool" });
    expect(result.presentation?.summary).toBeUndefined();
    expect(result.presentation?.title).toBeUndefined();
    expect(result.presentation?.narration).toBeUndefined();
  });

  it("does not strip `_summary` on the host dispatch door (model-door only)", async () => {
    // A host `dispatch` input is passed through untouched — the field is
    // NOT treated as narration. Presentation falls to displaySummary here.
    const result = await dispatchWith(
      { displaySummary: "author summary" },
      { query: "x", [TOOL_NARRATION_FIELD]: "should be ignored on the host door" },
      "dispatch",
    );
    expect(result.presentation?.narration).toBeUndefined();
    expect(result.presentation?.summary).toBe("author summary");
  });
});
