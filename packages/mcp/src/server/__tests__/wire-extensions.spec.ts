/**
 * MCP wire extensions — the `metadata.mcp` carriage convention and its
 * declaration-side projection, across all four sites (tool, tool result,
 * prompt, resource).
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
 *  - The wire `Tool.title` resolves `metadata.title ?? annotations.title`,
 *    so a title authored via `createTool({ title })` reaches the wire and
 *    a `setTitle` transform still overrides it.
 *  - Prompts and resources carry the SAME conventions: `title`, `icons`,
 *    and `metadata.mcp.meta` → wire `_meta`; absent ⇒ nothing emitted.
 */

import { describe, expect, it } from "vitest";
import { IconSchema, IconsSchema } from "@modelcontextprotocol/sdk/types.js";
import { jsonSchema, type ToolDeclaration } from "@agentick/spec";
import type { IconDescriptor } from "@agentick/tool/transforms";

import { toWirePrompt } from "../projection/prompts.js";
import { toWireResource, toWireResourceTemplate } from "../projection/resources.js";
import { toWireTool } from "../projection/tools.js";
import {
  MCP_METADATA_KEY,
  mcpPromptExtensions,
  mcpResourceExtensions,
  mcpResultExtensions,
  mcpToolExtensions,
  readMcpDeclarationExtensions,
  readMcpResultExtensions,
  readMcpToolExtensions,
} from "../wire-extensions.js";

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

describe("mcp wire-extensions — helper + reader shapes", () => {
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

describe("toWireTool — title sources", () => {
  it("projects an authored annotations.title when no metadata.title overrides it", () => {
    // `createTool({ title })` lands on `annotations.title`; reading only
    // `metadata.title` silently dropped it from the wire.
    const wire = toWireTool({ ...decl("search"), annotations: { title: "Search Invoices" } });
    expect(wire.title).toBe("Search Invoices");
  });

  it("metadata.title wins — it is the per-connection override", () => {
    const wire = toWireTool({
      ...decl("search", { title: "Find Invoices" }),
      annotations: { title: "Search Invoices" },
    });
    expect(wire.title).toBe("Find Invoices");
  });

  it("emits no title when neither source carries one", () => {
    expect("title" in toWireTool(decl("plain2"))).toBe(false);
  });
});

describe("toWirePrompt — title / icons / _meta", () => {
  const icons = [{ src: "https://example.com/p.png", mimeType: "image/png" }];

  it("projects the declaration title, icons, and metadata.mcp.meta", () => {
    const wire = toWirePrompt({
      name: "jobs_over_budget",
      title: "Jobs Over Budget",
      description: "Jobs past their budget.",
      metadata: {
        icons,
        ...mcpPromptExtensions({ meta: { "openai/outputTemplate": "ui://widget/jobs" } }),
      },
    });
    expect(wire.title).toBe("Jobs Over Budget");
    expect(wire.icons).toEqual(icons);
    expect(wire._meta).toEqual({ "openai/outputTemplate": "ui://widget/jobs" });
  });

  it("metadata.title overrides the declaration title", () => {
    const wire = toWirePrompt({
      name: "p",
      title: "Declared",
      description: "d",
      metadata: { title: "Relabelled" },
    });
    expect(wire.title).toBe("Relabelled");
  });

  it("REGRESSION: a bare declaration projects name + description only", () => {
    const wire = toWirePrompt({ name: "p", description: "d" });
    expect(wire).toEqual({ name: "p", description: "d" });
  });
});

describe("toWireResource / toWireResourceTemplate — title / icons / _meta", () => {
  const icons = [{ src: "https://example.com/r.svg", mimeType: "image/svg+xml" }];

  it("projects a fixed resource's display + extension fields", () => {
    const wire = toWireResource({
      uri: "file:///reports/q1.pdf",
      name: "q1_report",
      title: "Q1 Report",
      metadata: { icons, ...mcpResourceExtensions({ meta: { "acme/kind": "report" } }) },
    });
    expect(wire.title).toBe("Q1 Report");
    expect(wire.icons).toEqual(icons);
    expect(wire._meta).toEqual({ "acme/kind": "report" });
  });

  it("projects a template's display + extension fields", () => {
    const wire = toWireResourceTemplate({
      uriTemplate: "file:///reports/{quarter}.pdf",
      name: "report",
      metadata: { title: "Quarterly Report", ...mcpResourceExtensions({ meta: { v: 2 } }) },
    });
    expect(wire.title).toBe("Quarterly Report");
    expect(wire._meta).toEqual({ v: 2 });
  });

  it("REGRESSION: bare descriptors project their locator + name only", () => {
    expect(toWireResource({ uri: "file:///a", name: "a" })).toEqual({
      uri: "file:///a",
      name: "a",
    });
    expect(toWireResourceTemplate({ uriTemplate: "file:///{x}", name: "t" })).toEqual({
      uriTemplate: "file:///{x}",
      name: "t",
    });
  });
});

describe("icons — the convention parses as the wire type", () => {
  // The gap #259 closed: `IconDescriptor.sizes` was a space-separated string
  // (the HTML `<link rel="icon">` shape) cast straight onto MCP's `string[]`,
  // so a declared `sizes` reached the wire in a shape the schema rejects — and
  // no test noticed, because nothing validated a projection against the SDK's
  // own schema. Validate against `IconSchema` itself, not a hand-copy of it,
  // so an SDK tightening surfaces here rather than at a connected client.
  const icons: readonly IconDescriptor[] = [
    { src: "https://example.com/i.svg", sizes: ["any"], mimeType: "image/svg+xml" },
    { src: "https://example.com/i-64.png", sizes: ["16x16", "64x64"], mimeType: "image/png" },
  ];

  it("projected icons parse under the SDK Icon schema, on all four surfaces", () => {
    // `IconsSchema` is the `{ icons?: Icon[] }` MIXIN, so the whole projected
    // record goes in — which also pins that each surface emits the icons under
    // the key the wire reads.
    const projected = {
      tool: toWireTool(decl("t", { icons })),
      prompt: toWirePrompt({ name: "p", description: "d", metadata: { icons } }),
      resource: toWireResource({ uri: "file:///a", name: "a", metadata: { icons } }),
      template: toWireResourceTemplate({
        uriTemplate: "file:///{x}",
        name: "t",
        metadata: { icons },
      }),
    };
    for (const [surface, wire] of Object.entries(projected)) {
      const parsed = IconsSchema.safeParse(wire);
      // Assert on a surface-tagged message rather than a bare boolean, so a
      // failure names WHICH projection broke and what the schema objected to.
      expect(`${surface}: ${parsed.success ? "ok" : parsed.error.message}`).toBe(`${surface}: ok`);
      expect(parsed.data?.icons).toHaveLength(2);
    }
  });

  it("the pre-#259 string form is what the schema rejects", () => {
    // Pins WHY the convention changed rather than the projections splitting the
    // string: the old authoring shape was never wire-valid.
    expect(IconSchema.safeParse({ src: "/i.png", sizes: "16x16 64x64" }).success).toBe(false);
    expect(IconSchema.safeParse({ src: "/i.png", sizes: ["16x16", "64x64"] }).success).toBe(true);
  });
});

describe("readMcpDeclarationExtensions", () => {
  it("round-trips both builders and rejects a malformed block", () => {
    expect(readMcpDeclarationExtensions(mcpPromptExtensions({ meta: { a: 1 } }))?.meta).toEqual({
      a: 1,
    });
    expect(readMcpDeclarationExtensions(mcpResourceExtensions({ meta: { b: 2 } }))?.meta).toEqual({
      b: 2,
    });
    expect(readMcpDeclarationExtensions({ mcp: "nope" })).toBeUndefined();
    expect(readMcpDeclarationExtensions(undefined)).toBeUndefined();
  });
});

describe("toWireTool — catalog metadata", () => {
  it("emits `group` and `summary` under `_meta['agentick/*']`, adopter meta winning on collision", () => {
    const wire = toWireTool({
      ...decl("search_invoices", mcpToolExtensions({ meta: { "agentick/summary": "adopter" } })),
      group: ["invoicing"],
      summary: "Find invoices.",
    });
    expect(wire._meta).toEqual({ "agentick/group": ["invoicing"], "agentick/summary": "adopter" });
  });

  it("emits no `_meta` when the declaration carries neither", () => {
    expect(toWireTool(decl("search_invoices"))._meta).toBeUndefined();
  });
});
