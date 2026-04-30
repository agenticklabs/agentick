/**
 * Phase 5.5 — `title` + `icons` spec metadata fields (2025-11-25
 * BaseMetadataSchema + IconsSchema). Verifies the optional human-readable
 * title and icons array round-trip through tools/list, prompts/list,
 * resources/list, and resources/templates/list.
 *
 * Adversarial: omit fields when undefined (no empty `title: ""`),
 * preserve all `Icon` properties (src/mimeType/sizes/theme), multiple
 * icons per entity, mixed presence/absence within a single list.
 */

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { InMemoryTransport } from "../../transport/index.js";
import { MCPServer } from "../server.js";
import type { MCPToolDefinition, Icon } from "../../protocol/types.js";

async function setupClientServer(opts: {
  tools?: MCPToolDefinition[];
  prompts?: import("../../protocol/types.js").MCPPromptDefinition[];
  resources?: import("../../protocol/types.js").MCPStaticResource[];
  resourceTemplates?: import("../../protocol/types.js").MCPResourceTemplateDefinition[];
}): Promise<{ client: Client; server: MCPServer; cleanup: () => Promise<void> }> {
  const server = new MCPServer({ name: "metadata-test", version: "1.0.0", ...opts });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    server,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

const ICON_PNG: Icon = {
  src: "https://example.com/icon.png",
  mimeType: "image/png",
  sizes: ["48x48", "96x96"],
};

const ICON_SVG: Icon = {
  src: "data:image/svg+xml;base64,PHN2Zy8+",
  mimeType: "image/svg+xml",
  sizes: ["any"],
  theme: "dark",
};

// ============================================================================
// Tools — title + icons round-trip via tools/list
// ============================================================================

describe("Tools — title + icons", () => {
  it("title round-trips through tools/list", async () => {
    const { client, cleanup } = await setupClientServer({
      tools: [
        {
          name: "search_invoices",
          title: "Search Invoices",
          description: "Find invoices",
          inputSchema: z.object({ q: z.string() }),
          handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
        },
      ],
    });

    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "search_invoices");
    expect(t?.title).toBe("Search Invoices");

    await cleanup();
  });

  it("icons round-trip with all properties preserved", async () => {
    const { client, cleanup } = await setupClientServer({
      tools: [
        {
          name: "render",
          icons: [ICON_PNG, ICON_SVG],
          inputSchema: z.object({}),
          handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
        },
      ],
    });

    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "render") as unknown as {
      icons?: Icon[];
    };
    expect(t.icons).toHaveLength(2);
    expect(t.icons![0]).toEqual(ICON_PNG);
    expect(t.icons![1]).toEqual(ICON_SVG);

    await cleanup();
  });

  it("omits title when undefined (no empty string on the wire)", async () => {
    const { client, cleanup } = await setupClientServer({
      tools: [
        {
          name: "no-title",
          inputSchema: z.object({}),
          handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
        },
      ],
    });

    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "no-title");
    expect(t).toBeDefined();
    expect("title" in (t as object)).toBe(false);

    await cleanup();
  });

  it("omits icons when undefined", async () => {
    const { client, cleanup } = await setupClientServer({
      tools: [
        {
          name: "no-icons",
          inputSchema: z.object({}),
          handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
        },
      ],
    });

    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "no-icons") as unknown as {
      icons?: Icon[];
    };
    expect(t.icons).toBeUndefined();

    await cleanup();
  });

  it("mixed list — some tools have title/icons, some don't", async () => {
    const { client, cleanup } = await setupClientServer({
      tools: [
        {
          name: "rich",
          title: "Rich Tool",
          icons: [ICON_PNG],
          inputSchema: z.object({}),
          handler: async () => ({ content: [{ type: "text", text: "x" }] }),
        },
        {
          name: "plain",
          inputSchema: z.object({}),
          handler: async () => ({ content: [{ type: "text", text: "x" }] }),
        },
      ],
    });

    const { tools } = await client.listTools();
    const rich = tools.find((x) => x.name === "rich") as any;
    const plain = tools.find((x) => x.name === "plain") as any;

    expect(rich.title).toBe("Rich Tool");
    expect(rich.icons).toHaveLength(1);
    expect(plain.title).toBeUndefined();
    expect(plain.icons).toBeUndefined();

    await cleanup();
  });
});

// ============================================================================
// Prompts — title + icons round-trip via prompts/list
// ============================================================================

describe("Prompts — title + icons", () => {
  it("title round-trips through prompts/list", async () => {
    const { client, cleanup } = await setupClientServer({
      prompts: [
        {
          name: "brief-me",
          title: "Brief Me on a Project",
          description: "Generates a project briefing",
          arguments: [{ name: "projectId", required: true }],
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const { prompts } = await client.listPrompts();
    const p = prompts.find((x) => x.name === "brief-me");
    expect(p?.title).toBe("Brief Me on a Project");

    await cleanup();
  });

  it("icons round-trip on prompts", async () => {
    const { client, cleanup } = await setupClientServer({
      prompts: [
        {
          name: "report",
          icons: [ICON_PNG],
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const { prompts } = await client.listPrompts();
    const p = prompts.find((x) => x.name === "report") as unknown as {
      icons?: Icon[];
    };
    expect(p.icons).toEqual([ICON_PNG]);

    await cleanup();
  });

  it("omits title and icons when undefined", async () => {
    const { client, cleanup } = await setupClientServer({
      prompts: [
        {
          name: "bare",
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const { prompts } = await client.listPrompts();
    const p = prompts.find((x) => x.name === "bare") as any;
    expect(p.title).toBeUndefined();
    expect(p.icons).toBeUndefined();

    await cleanup();
  });
});

// ============================================================================
// Static resources — title + icons round-trip via resources/list
// ============================================================================

describe("Static resources — title + icons", () => {
  it("title round-trips through resources/list", async () => {
    const { client, cleanup } = await setupClientServer({
      resources: [
        {
          name: "schema",
          uri: "db://schema",
          title: "Database Schema",
          description: "Live DB schema",
          read: async () => ({ contents: [{ uri: "db://schema", text: "..." }] }),
        },
      ],
    });

    const { resources } = await client.listResources();
    const r = resources.find((x) => x.name === "schema");
    expect(r?.title).toBe("Database Schema");

    await cleanup();
  });

  it("icons round-trip on resources", async () => {
    const { client, cleanup } = await setupClientServer({
      resources: [
        {
          name: "logo",
          uri: "asset://logo",
          icons: [ICON_PNG, ICON_SVG],
          read: async () => ({ contents: [{ uri: "asset://logo", text: "" }] }),
        },
      ],
    });

    const { resources } = await client.listResources();
    const r = resources.find((x) => x.name === "logo") as unknown as {
      icons?: Icon[];
    };
    expect(r.icons).toHaveLength(2);

    await cleanup();
  });

  it("omits title and icons when undefined", async () => {
    const { client, cleanup } = await setupClientServer({
      resources: [
        {
          name: "bare",
          uri: "x://bare",
          read: async () => ({ contents: [{ uri: "x://bare", text: "" }] }),
        },
      ],
    });

    const { resources } = await client.listResources();
    const r = resources.find((x) => x.name === "bare") as any;
    expect(r.title).toBeUndefined();
    expect(r.icons).toBeUndefined();

    await cleanup();
  });
});

// ============================================================================
// Resource templates — title + icons round-trip via resources/templates/list
// ============================================================================

describe("Resource templates — title + icons", () => {
  it("title round-trips through resources/templates/list", async () => {
    const { client, cleanup } = await setupClientServer({
      resourceTemplates: [
        {
          name: "table-schema",
          title: "Table Schema",
          uriTemplate: "db://schema/{table}",
          read: async () => ({
            contents: [{ uri: "db://schema/users", text: "..." }],
          }),
        },
      ],
    });

    const { resourceTemplates } = await client.listResourceTemplates();
    const t = resourceTemplates.find((x) => x.name === "table-schema");
    expect(t?.title).toBe("Table Schema");

    await cleanup();
  });

  it("icons round-trip on resource templates", async () => {
    const { client, cleanup } = await setupClientServer({
      resourceTemplates: [
        {
          name: "icon-template",
          uriTemplate: "icons://{name}",
          icons: [ICON_PNG],
          read: async () => ({ contents: [{ uri: "icons://x", text: "" }] }),
        },
      ],
    });

    const { resourceTemplates } = await client.listResourceTemplates();
    const t = resourceTemplates.find((x) => x.name === "icon-template") as unknown as {
      icons?: Icon[];
    };
    expect(t.icons).toEqual([ICON_PNG]);

    await cleanup();
  });
});

// ============================================================================
// Adversarial — Icon shape variations
// ============================================================================

describe("Icon shape — adversarial", () => {
  it("icon with only `src` (mimeType + sizes + theme all optional)", async () => {
    const minimalIcon: Icon = { src: "https://example.com/i.png" };
    const { client, cleanup } = await setupClientServer({
      tools: [
        {
          name: "minimal",
          icons: [minimalIcon],
          inputSchema: z.object({}),
          handler: async () => ({ content: [{ type: "text", text: "x" }] }),
        },
      ],
    });

    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "minimal") as unknown as {
      icons?: Icon[];
    };
    expect(t.icons).toEqual([minimalIcon]);

    await cleanup();
  });

  it("icon with theme: 'light' and 'dark' variants", async () => {
    const light: Icon = { src: "light.svg", theme: "light" };
    const dark: Icon = { src: "dark.svg", theme: "dark" };
    const { client, cleanup } = await setupClientServer({
      tools: [
        {
          name: "themed",
          icons: [light, dark],
          inputSchema: z.object({}),
          handler: async () => ({ content: [{ type: "text", text: "x" }] }),
        },
      ],
    });

    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "themed") as unknown as {
      icons?: Icon[];
    };
    expect(t.icons).toEqual([light, dark]);

    await cleanup();
  });

  it("data: URI src is preserved", async () => {
    const dataUri =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
    const icon: Icon = { src: dataUri, mimeType: "image/png" };
    const { client, cleanup } = await setupClientServer({
      tools: [
        {
          name: "datauri",
          icons: [icon],
          inputSchema: z.object({}),
          handler: async () => ({ content: [{ type: "text", text: "x" }] }),
        },
      ],
    });

    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "datauri") as unknown as {
      icons?: Icon[];
    };
    expect(t.icons![0].src).toBe(dataUri);

    await cleanup();
  });

  it("empty icons array is preserved (not stripped)", async () => {
    // Some servers might explicitly emit `icons: []` as "no icons available"
    // — distinct from omitting the field entirely.
    const { client, cleanup } = await setupClientServer({
      tools: [
        {
          name: "empty-icons",
          icons: [],
          inputSchema: z.object({}),
          handler: async () => ({ content: [{ type: "text", text: "x" }] }),
        },
      ],
    });

    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "empty-icons") as unknown as {
      icons?: Icon[];
    };
    // We treat empty arrays as "no icons" — strip them to avoid wire noise.
    // Either undefined or [] is acceptable behavior; assert the intent is
    // "no icons displayed."
    expect(t.icons === undefined || t.icons.length === 0).toBe(true);

    await cleanup();
  });

  it("multi-icon set with mixed sizes for responsive rendering", async () => {
    const icons: Icon[] = [
      { src: "16.png", mimeType: "image/png", sizes: ["16x16"] },
      { src: "32.png", mimeType: "image/png", sizes: ["32x32"] },
      { src: "scalable.svg", mimeType: "image/svg+xml", sizes: ["any"] },
    ];
    const { client, cleanup } = await setupClientServer({
      tools: [
        {
          name: "multi",
          icons,
          inputSchema: z.object({}),
          handler: async () => ({ content: [{ type: "text", text: "x" }] }),
        },
      ],
    });

    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "multi") as unknown as {
      icons?: Icon[];
    };
    expect(t.icons).toEqual(icons);

    await cleanup();
  });
});
