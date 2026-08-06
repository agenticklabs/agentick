/**
 * The README's client-tool examples, executed.
 *
 * Written against the PUBLIC subpath (`../client/index.js`) with a real zod
 * schema, because that is what an adopter types. A README example that is only
 * proofread rots the first time a signature moves; this one fails to compile.
 *
 * @verifiedBy this file
 */

import { describe, expect, it } from "vitest";
import { NOOP_METRICS, OFF_TRACE, createLog } from "@agentick/spec";
import { z } from "zod";

import { createClientTool, toClientToolDeclaration } from "../client/index.js";

// ── README: "A client tool is one object" ───────────────────────────────────
const readSelection = createClientTool({
  name: "read_selection",
  description: "What the user currently has highlighted on the page",
  inputSchema: z.object({ includeHtml: z.boolean().optional() }),
  handler: async ({ includeHtml }, ctx) => {
    ctx.log.info({ msg: "reading selection" });
    return includeHtml ? "<b>highlighted</b>" : "highlighted";
  },
});

// ── README: "When the user has several tabs open" ───────────────────────────
const navigateTo = createClientTool({
  name: "navigate_to",
  description: "Navigate this tab to a route",
  inputSchema: z.object({ to: z.string() }),
  accepts: ({ target, self }) => target === undefined || target === self,
  handler: async ({ to }) => `navigated to ${to}`,
});

describe("the README's examples", () => {
  it("type-checks with a real zod schema and infers the handler's input", async () => {
    // `includeHtml` and `to` are typed off the schema — no cast in either
    // handler above, which is the claim the example makes by omission.
    await expect(readSelection.handler({ includeHtml: true }, ctx())).resolves.toBe(
      "<b>highlighted</b>",
    );
    await expect(navigateTo.handler({ to: "/reports" }, ctx())).resolves.toBe(
      "navigated to /reports",
    );
  });

  it("projects a zod schema to the JSON Schema the wire carries", () => {
    const declaration = toClientToolDeclaration(navigateTo);
    expect(declaration.name).toBe("navigate_to");
    expect(declaration.inputSchema).toMatchObject({
      type: "object",
      properties: { to: { type: "string" } },
    });
  });

  it("the documented `accepts` rule declines a call addressed elsewhere", () => {
    const decide = (self: string, target?: string) =>
      navigateTo.accepts?.({ name: "navigate_to", input: {}, self, target });

    expect(decide("conn-A", "conn-A")).toBe(true);
    expect(decide("conn-A", "conn-B")).toBe(false);
    // Unaddressed — every tab takes it, which is why the stamp matters.
    expect(decide("conn-A", undefined)).toBe(true);
  });
});

function ctx(): Parameters<typeof readSelection.handler>[1] {
  return {
    toolCallId: "tc-1",
    name: "read_selection",
    signal: new AbortController().signal,
    clientId: "c1",
    connectionId: "conn-A",
    log: createLog(() => {}),
    trace: OFF_TRACE,
    metrics: NOOP_METRICS,
    activeSpan: () => undefined,
  };
}
