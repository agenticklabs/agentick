/**
 * Declaration intrinsics — `<tool>`, `<mcp>`, `<resource>`,
 * `<output>`, `<model>`. ADR 39 Phase 3 Step 3b.
 *
 * Pins:
 *  - Each emits the right declaration shape on `RenderedTree`
 *  - Diagnostic codes for missing-required-field cases
 *  - `<model>` lands on `tree.config` + `tree.providerOptions`,
 *    not on `tree.declarations`
 *  - Combined: tools + resources + mcp + output coexist
 *  - `<tool>` description folds from children when no `description`
 *    prop is supplied
 *  - id-fallback uses the host instance's `hostId`
 *  - `<message role="tool">` still produces a tool-result message
 *    (regression guard — Step 3b removed `<tool>` from the role
 *    shorthand fall-through)
 */

import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { compileToTree } from "../index.js";

const inputSchema = z.object({ q: z.string() });

describe("<tool> declaration", () => {
  it("emits a ToolDeclaration onto tree.declarations.tools", async () => {
    const tree = await compileToTree(
      createElement("tool" as never, { name: "search", inputSchema }),
    );
    expect(tree.declarations?.tools).toHaveLength(1);
    const t = tree.declarations!.tools![0]!;
    expect(t.name).toBe("search");
    expect(t.inputSchema).toBe(inputSchema);
    expect(t.exposure).toEqual(["model"]);
    expect(t.description).toBe("");
    expect(t.id).toMatch(/^tool\./);
  });

  it("uses children's text as description fallback", async () => {
    const tree = await compileToTree(
      createElement("tool" as never, { name: "search", inputSchema }, "Search the docs."),
    );
    const t = tree.declarations!.tools![0]!;
    expect(t.description).toBe("Search the docs.");
  });

  it("explicit description prop wins over children text", async () => {
    const tree = await compileToTree(
      createElement(
        "tool" as never,
        { name: "search", inputSchema, description: "explicit" },
        "ignored body",
      ),
    );
    expect(tree.declarations!.tools![0]!.description).toBe("explicit");
  });

  it("explicit id prop wins over hostId fallback", async () => {
    const tree = await compileToTree(
      createElement("tool" as never, { id: "my.tool", name: "search", inputSchema }),
    );
    expect(tree.declarations!.tools![0]!.id).toBe("my.tool");
  });

  it("passes outputSchema, exposure, handlerRef, annotations, metadata through", async () => {
    const outputSchema = z.string();
    const tree = await compileToTree(
      createElement("tool" as never, {
        name: "search",
        inputSchema,
        outputSchema,
        exposure: ["model"],
        handlerRef: "h.123",
        annotations: { destructiveHint: true } as never,
        metadata: { tag: "v1" },
      }),
    );
    const t = tree.declarations!.tools![0]!;
    expect(t.outputSchema).toBe(outputSchema);
    expect(t.exposure).toEqual(["model"]);
    expect(t.handlerRef).toBe("h.123");
    expect(t.annotations).toEqual({ destructiveHint: true });
    expect(t.metadata).toEqual({ tag: "v1" });
  });

  it("missing name emits diagnostic and drops the declaration", async () => {
    const tree = await compileToTree(createElement("tool" as never, { inputSchema }));
    expect(tree.declarations).toBeUndefined();
    expect(tree.diagnostics?.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "warning", code: "tool-missing-name" }),
    );
  });

  it("missing inputSchema emits diagnostic and drops the declaration", async () => {
    const tree = await compileToTree(createElement("tool" as never, { name: "search" }));
    expect(tree.declarations).toBeUndefined();
    expect(tree.diagnostics?.diagnostics).toContainEqual(
      expect.objectContaining({ severity: "warning", code: "tool-missing-input-schema" }),
    );
  });
});

describe("<mcp> declaration", () => {
  it("emits an MCPDeclaration onto tree.declarations.mcp", async () => {
    const transport = { kind: "stdio" as const, command: "echo" };
    const tree = await compileToTree(
      createElement("mcp" as never, {
        serverName: "search-mcp",
        transport,
        config: { foo: "bar" },
      }),
    );
    expect(tree.declarations?.mcp).toHaveLength(1);
    const m = tree.declarations!.mcp![0]!;
    expect(m.serverName).toBe("search-mcp");
    expect(m.transport).toBe(transport);
    expect(m.config).toEqual({ foo: "bar" });
    expect(m.id).toMatch(/^mcp\./);
  });

  it("missing serverName emits diagnostic", async () => {
    const tree = await compileToTree(
      createElement("mcp" as never, { transport: { kind: "stdio", command: "echo" } }),
    );
    expect(tree.declarations).toBeUndefined();
    expect(tree.diagnostics?.diagnostics).toContainEqual(
      expect.objectContaining({ code: "mcp-missing-fields" }),
    );
  });

  it("missing transport emits diagnostic", async () => {
    const tree = await compileToTree(createElement("mcp" as never, { serverName: "x" }));
    expect(tree.declarations).toBeUndefined();
    expect(tree.diagnostics?.diagnostics).toContainEqual(
      expect.objectContaining({ code: "mcp-missing-fields" }),
    );
  });
});

describe("<resource> declaration", () => {
  it("emits a ResourceDeclaration onto tree.declarations.resources", async () => {
    const tree = await compileToTree(
      createElement("resource" as never, {
        uri: "file:///foo.txt",
        name: "foo",
        mimeType: "text/plain",
      }),
    );
    expect(tree.declarations?.resources).toHaveLength(1);
    const r = tree.declarations!.resources![0]!;
    expect(r.uri).toBe("file:///foo.txt");
    expect(r.name).toBe("foo");
    expect(r.mimeType).toBe("text/plain");
    expect(r.id).toMatch(/^resource\./);
  });

  it("bare <resource /> still emits — only id is required (auto-derived)", async () => {
    const tree = await compileToTree(createElement("resource" as never, null));
    expect(tree.declarations?.resources).toHaveLength(1);
    expect(tree.declarations!.resources![0]!.id).toMatch(/^resource\./);
  });
});

describe("<output> declaration", () => {
  it("emits an OutputDeclaration onto tree.declarations.outputs", async () => {
    const schema = z.object({ summary: z.string() });
    const tree = await compileToTree(
      createElement("output" as never, { id: "summary", schema, mode: "structured" }),
    );
    expect(tree.declarations?.outputs).toHaveLength(1);
    const o = tree.declarations!.outputs![0]!;
    expect(o.id).toBe("summary");
    expect(o.schema).toBe(schema);
    expect(o.mode).toBe("structured");
  });
});

describe("<model> config", () => {
  it("emits SpecConfig fragment from id + generation knobs", async () => {
    const tree = await compileToTree(
      createElement("model" as never, {
        id: "gpt-5",
        temperature: 0.7,
        maxOutputTokens: 1024,
      }),
    );
    expect(tree.config?.model).toEqual({ kind: "by-id", id: "gpt-5" });
    expect(tree.config?.temperature).toBe(0.7);
    expect(tree.config?.maxOutputTokens).toBe(1024);
    // <model> does NOT land on tree.declarations
    expect(tree.declarations).toBeUndefined();
  });

  // NOTE: `ref` is a reserved React prop name — React strips it before
  // the host config sees it. Adopters who want to use `ref` semantics
  // must pass it via `createElement("model", {...{ref: "x"}})` spread,
  // OR use an uppercase function-component wrapper that maps a renamed
  // prop (e.g. `modelRef`) → `ref` internally. Tracked as a Phase 4+
  // ergonomic.
  it.skip("ref prop produces by-ref model (blocked by React's reserved `ref` prop)", () => {
    /* see note above */
  });

  it.skip("id takes precedence over ref when both supplied (blocked by React's reserved `ref` prop)", () => {
    /* see note above */
  });

  it("providerOptions land on tree.providerOptions, not tree.config", async () => {
    const tree = await compileToTree(
      createElement("model" as never, {
        id: "gpt-5",
        providerOptions: { openai: { strictJsonMode: true } } as never,
      }),
    );
    expect(tree.providerOptions).toEqual({ openai: { strictJsonMode: true } });
    expect(tree.config?.model).toEqual({ kind: "by-id", id: "gpt-5" });
  });

  it("bare <model /> emits nothing — clean tree", async () => {
    const tree = await compileToTree(createElement("model" as never, null));
    expect(tree.config).toBeUndefined();
    expect(tree.providerOptions).toBeUndefined();
    expect(tree.declarations).toBeUndefined();
    expect(tree.diagnostics).toBeUndefined();
  });
});

describe("declarations coexist with content + entries", () => {
  it("a template can mix tools, resources, mcp, sections, and content", async () => {
    const Tpl = () =>
      createElement(
        "section" as never,
        { id: "main" },
        "Use the search tool when needed.",
        createElement("tool" as never, { name: "search", inputSchema }),
        createElement("mcp" as never, {
          serverName: "remote",
          transport: { kind: "stdio", command: "echo" },
        }),
        createElement("resource" as never, { uri: "file:///data.csv", name: "data" }),
      );
    const tree = await compileToTree(createElement(Tpl));
    // One section entry
    expect(tree.context.entries).toHaveLength(1);
    expect(tree.context.entries[0]!.kind).toBe("section");
    // All three declarations
    expect(tree.declarations?.tools).toHaveLength(1);
    expect(tree.declarations?.mcp).toHaveLength(1);
    expect(tree.declarations?.resources).toHaveLength(1);
  });
});

describe('<message role="tool"> regression guard', () => {
  it("produces a tool-result message entry — NOT a declaration", async () => {
    // After Step 3b removed `<tool>` from the role-shorthand
    // fall-through, tool-result messages must use the explicit form
    // <message role="tool">.
    const tree = await compileToTree(
      createElement("message" as never, { role: "tool", id: "t1" }, "search returned: 42"),
    );
    expect(tree.context.entries).toHaveLength(1);
    const e = tree.context.entries[0]!;
    expect(e.kind).toBe("message");
    if (e.kind !== "message") throw new Error("expected message");
    expect(e.role).toBe("tool");
    expect(e.id).toBe("t1");
    // Definitely NOT a declaration
    expect(tree.declarations).toBeUndefined();
  });
});
