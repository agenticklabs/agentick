/**
 * MCP tool wire extensions (3b-0b-B) — the `metadata.mcp` carriage
 * convention + its declaration-side projection through `toWireTool`.
 *
 * Pins:
 *  - Helper shapes: `mcpToolExtensions` / `mcpResultExtensions` build a
 *    single namespaced `{ mcp: … }` fragment; readers round-trip it and
 *    reject malformed blocks.
 *  - `toWireTool` projects `metadata.mcp.meta` → wire `Tool._meta` and
 *    `metadata.mcp.annotations` → wire `Tool.annotations` (advisory hints).
 *  - Regression guard: a declaration with NO `mcp` block projects to a
 *    wire `Tool` byte-identical to before (no `_meta`, no `annotations`).
 *  - Partial hints emit only the set keys; an all-empty hint object emits
 *    no `annotations` block.
 */

import { describe, expect, it } from "vitest";
import { jsonSchema, type ToolDeclaration } from "@agentick/spec";

import { toWireTool } from "../projection/tools.js";
import {
  MCP_METADATA_KEY,
  mcpResultExtensions,
  mcpToolExtensions,
  readMcpResultExtensions,
  readMcpToolExtensions,
} from "../tool-extensions.js";

const schema = jsonSchema({ type: "object", properties: { q: { type: "string" } } });

function decl(name: string, metadata?: Readonly<Record<string, unknown>>): ToolDeclaration {
  return {
    id: name,
    name,
    description: `desc:${name}`,
    inputSchema: schema,
    exposure: ["model"],
    handlerRef: `handler:${name}`,
    ...(metadata ? { metadata } : {}),
  };
}

describe("mcp tool-extensions — helper + reader shapes", () => {
  it("mcpToolExtensions nests under the single `mcp` key", () => {
    const frag = mcpToolExtensions({
      annotations: { readOnlyHint: true },
      meta: { "openai/outputTemplate": "ui://widget/list" },
    });
    expect(Object.keys(frag)).toEqual([MCP_METADATA_KEY]);
    expect(frag).toEqual({
      mcp: {
        annotations: { readOnlyHint: true },
        meta: { "openai/outputTemplate": "ui://widget/list" },
      },
    });
  });

  it("mcpResultExtensions nests under the single `mcp` key", () => {
    const frag = mcpResultExtensions({ meta: { "mcp/www_authenticate": "Bearer" } });
    expect(frag).toEqual({ mcp: { meta: { "mcp/www_authenticate": "Bearer" } } });
  });

  it("readers round-trip the fragment", () => {
    const declFrag = mcpToolExtensions({ annotations: { destructiveHint: true } });
    expect(readMcpToolExtensions(declFrag)).toEqual({ annotations: { destructiveHint: true } });

    const resFrag = mcpResultExtensions({ meta: { k: "v" } });
    expect(readMcpResultExtensions(resFrag)).toEqual({ meta: { k: "v" } });
  });

  it("readers return undefined for absent or malformed blocks", () => {
    expect(readMcpToolExtensions(undefined)).toBeUndefined();
    expect(readMcpToolExtensions({})).toBeUndefined();
    expect(readMcpToolExtensions({ mcp: "not-an-object" })).toBeUndefined();
    expect(readMcpToolExtensions({ mcp: null })).toBeUndefined();
    expect(readMcpResultExtensions({ other: 1 })).toBeUndefined();
  });
});

describe("toWireTool — declaration extensions projection", () => {
  it("projects mcp.meta onto wire Tool._meta and mcp.annotations onto Tool.annotations", () => {
    const wire = toWireTool(
      decl(
        "search_invoices",
        mcpToolExtensions({
          annotations: { readOnlyHint: true, openWorldHint: false },
          meta: { "openai/outputTemplate": "ui://widget/invoice-list" },
        }),
      ),
    );
    expect(wire._meta).toEqual({ "openai/outputTemplate": "ui://widget/invoice-list" });
    expect(wire.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
  });

  it("emits only the hint keys that were set (partial annotations)", () => {
    const wire = toWireTool(
      decl("delete_thing", mcpToolExtensions({ annotations: { destructiveHint: true } })),
    );
    expect(wire.annotations).toEqual({ destructiveHint: true });
    expect(wire._meta).toBeUndefined();
  });

  it("emits no annotations block when the hint object is empty", () => {
    const wire = toWireTool(decl("noop", mcpToolExtensions({ annotations: {} })));
    expect(wire.annotations).toBeUndefined();
  });

  it("REGRESSION: a declaration with no mcp block projects byte-identical to before", () => {
    // Baseline hand-built wire shape (name/description/inputSchema only) —
    // exactly what `toWireTool` produced before 3b-0b-B for a plain decl.
    const plain = decl("plain");
    const wire = toWireTool(plain);
    expect(wire).toEqual({
      name: "plain",
      description: "desc:plain",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    });
    expect("annotations" in wire).toBe(false);
    expect("_meta" in wire).toBe(false);
  });

  it("does not let annotations override the metadata.title wire title", () => {
    const wire = toWireTool(
      decl("titled", {
        title: "Titled Tool",
        ...mcpToolExtensions({ annotations: { readOnlyHint: true } }),
      }),
    );
    expect(wire.title).toBe("Titled Tool");
    expect(wire.annotations).toEqual({ readOnlyHint: true });
  });
});
