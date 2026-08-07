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

import { createTool, toDeclaration } from "../client/index.js";

// ── README: "A client tool is one object" ───────────────────────────────────
const readSelection = createTool({
  name: "read_selection",
  description: "What the user currently has highlighted on the page",
  inputSchema: z.object({ includeHtml: z.boolean().optional() }),
  handler: async ({ includeHtml }, ctx) => {
    ctx.log.info({ msg: "reading selection" });
    return includeHtml ? "<b>highlighted</b>" : "highlighted";
  },
});

// ── README: "When the user has several tabs open" ───────────────────────────
const navigateTo = createTool({
  name: "navigate_to",
  description: "Navigate this tab to a route",
  inputSchema: z.object({ to: z.string() }),
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
    const declaration = toDeclaration(navigateTo);
    expect(declaration.name).toBe("navigate_to");
    expect(declaration.inputSchema).toMatchObject({
      type: "object",
      properties: { to: { type: "string" } },
    });
  });

  it("carries no routing rule of its own — the framework addresses it", () => {
    // The README no longer shows an `accepts` predicate, because a rule
    // evaluated independently by N clients is only ever sound when it compares
    // against a value the server chose. That comparison is the framework's.
    expect("accepts" in navigateTo).toBe(false);
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
