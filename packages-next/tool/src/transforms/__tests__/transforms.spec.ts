/**
 * `@agentick/tool-next/transforms` — primitive coverage.
 *
 * Pins one assertion per primitive + composition + drop semantics.
 * Context is typed as `unknown` here; per-context behavior is tested
 * by downstream packages that bind a concrete `C` (e.g., the MCP
 * server projection passes `McpRequestContext`).
 */

import { describe as vdesc, expect, it } from "vitest";
import { jsonSchema, type ToolDeclaration } from "@agentick/spec-next";

import {
  allow,
  applyTransform,
  composeTransforms,
  deny,
  describe as describeT,
  filter,
  mapSchemas,
  onlyExposingTo,
  prefix,
  rename,
  renameBy,
  replaceInputSchema,
  replaceMetadata,
  replaceOutputSchema,
  setIcons,
  setMetadata,
  setTitle,
  suffix,
} from "../index.js";

const objectSchema = jsonSchema({ type: "object" });
const widerSchema = jsonSchema({ type: "object", properties: { foo: { type: "string" } } });

function tool(over: Partial<ToolDeclaration> & { name: string }): ToolDeclaration {
  return {
    id: over.name,
    name: over.name,
    description: over.description ?? "test",
    inputSchema: over.inputSchema ?? objectSchema,
    exposure: over.exposure ?? ["model"],
    handlerRef: over.handlerRef ?? `tool:${over.name}`,
    ...(over.outputSchema !== undefined ? { outputSchema: over.outputSchema } : {}),
    ...(over.annotations !== undefined ? { annotations: over.annotations } : {}),
    ...(over.metadata !== undefined ? { metadata: over.metadata } : {}),
  };
}

vdesc("ToolTransform — core composition", () => {
  it("composeTransforms(empty) is the identity", () => {
    const t = composeTransforms<unknown>();
    const x = tool({ name: "x" });
    expect(t.apply(x, undefined)).toBe(x);
  });

  it("composeTransforms(one) returns the same transform", () => {
    const ren = rename({ a: "b" });
    expect(composeTransforms(ren)).toBe(ren);
  });

  it("composeTransforms applies in left-to-right order", () => {
    const t = composeTransforms<unknown>(rename({ a: "b" }), prefix("api_"));
    const result = t.apply(tool({ name: "a" }), undefined);
    expect(result?.name).toBe("api_b");
  });

  it("first null short-circuits the chain", () => {
    let secondCalled = false;
    const guard = filter<unknown>(() => false);
    const after = {
      name: "after",
      apply: (x: ToolDeclaration) => {
        secondCalled = true;
        return x;
      },
    };
    const t = composeTransforms<unknown>(guard, after);
    expect(t.apply(tool({ name: "x" }), undefined)).toBeNull();
    expect(secondCalled).toBe(false);
  });

  it("applyTransform maps + drops over a list", () => {
    const t = deny<unknown>(["b"]);
    const out = applyTransform(
      t,
      [tool({ name: "a" }), tool({ name: "b" }), tool({ name: "c" })],
      undefined,
    );
    expect(out.map((t) => t.name)).toEqual(["a", "c"]);
  });
});

vdesc("rename / prefix / suffix / renameBy", () => {
  it("rename maps named tools, leaves others", () => {
    const t = rename({ a: "alpha" });
    expect(t.apply(tool({ name: "a" }), undefined)?.name).toBe("alpha");
    expect(t.apply(tool({ name: "b" }), undefined)?.name).toBe("b");
  });

  it("rename(false) drops the tool", () => {
    const t = rename({ deprecated: false });
    expect(t.apply(tool({ name: "deprecated" }), undefined)).toBeNull();
    expect(t.apply(tool({ name: "kept" }), undefined)?.name).toBe("kept");
  });

  it("prefix prepends", () => {
    expect(prefix("p_").apply(tool({ name: "x" }), undefined)?.name).toBe("p_x");
  });

  it("prefix unlessAlready skips already-prefixed names", () => {
    const t = prefix("p_", { unlessAlready: true });
    expect(t.apply(tool({ name: "p_x" }), undefined)?.name).toBe("p_x");
    expect(t.apply(tool({ name: "x" }), undefined)?.name).toBe("p_x");
  });

  it("suffix appends", () => {
    expect(suffix("_v2").apply(tool({ name: "x" }), undefined)?.name).toBe("x_v2");
  });

  it("renameBy maps via projection function", () => {
    const t = renameBy<unknown>((tool) => tool.name.toUpperCase());
    expect(t.apply(tool({ name: "x" }), undefined)?.name).toBe("X");
  });

  it("renameBy throws on empty projection", () => {
    const t = renameBy<unknown>(() => "");
    expect(() => t.apply(tool({ name: "x" }), undefined)).toThrow(/empty name/);
  });
});

vdesc("description / title / icons sugar", () => {
  it("describe rewrites description for named tools", () => {
    const t = describeT({ x: "new desc" });
    expect(t.apply(tool({ name: "x" }), undefined)?.description).toBe("new desc");
    expect(t.apply(tool({ name: "y" }), undefined)?.description).toBe("test");
  });

  it("setTitle sets metadata.title", () => {
    const t = setTitle({ x: "Pretty X" });
    expect(t.apply(tool({ name: "x" }), undefined)?.metadata).toEqual({ title: "Pretty X" });
  });

  it("setTitle preserves existing metadata", () => {
    const t = setTitle({ x: "Pretty X" });
    const result = t.apply(tool({ name: "x", metadata: { existing: 1 } }), undefined);
    expect(result?.metadata).toEqual({ existing: 1, title: "Pretty X" });
  });

  it("setIcons sets metadata.icons", () => {
    const t = setIcons({
      x: [{ src: "/x.svg", mimeType: "image/svg+xml" }],
    });
    const result = t.apply(tool({ name: "x" }), undefined);
    expect(result?.metadata).toEqual({
      icons: [{ src: "/x.svg", mimeType: "image/svg+xml" }],
    });
  });
});

vdesc("filter / allow / deny / onlyExposingTo", () => {
  it("filter drops tools where predicate returns false", () => {
    const t = filter<{ admin: boolean }>((tool, ctx) => ctx.admin || !tool.metadata?.adminOnly);
    const adminTool = tool({ name: "a", metadata: { adminOnly: true } });
    const userTool = tool({ name: "b" });
    expect(t.apply(adminTool, { admin: true })?.name).toBe("a");
    expect(t.apply(adminTool, { admin: false })).toBeNull();
    expect(t.apply(userTool, { admin: false })?.name).toBe("b");
  });

  it("allow keeps named matches + regex matches", () => {
    const t = allow(["search", /^read_/]);
    expect(t.apply(tool({ name: "search" }), undefined)?.name).toBe("search");
    expect(t.apply(tool({ name: "read_one" }), undefined)?.name).toBe("read_one");
    expect(t.apply(tool({ name: "write" }), undefined)).toBeNull();
  });

  it("deny drops named matches + regex matches", () => {
    const t = deny([/^admin_/, "dangerous"]);
    expect(t.apply(tool({ name: "admin_x" }), undefined)).toBeNull();
    expect(t.apply(tool({ name: "dangerous" }), undefined)).toBeNull();
    expect(t.apply(tool({ name: "safe" }), undefined)?.name).toBe("safe");
  });

  it("onlyExposingTo drops tools without the given audience", () => {
    const t = onlyExposingTo("dispatch");
    expect(t.apply(tool({ name: "x", exposure: ["dispatch"] }), undefined)?.name).toBe("x");
    expect(t.apply(tool({ name: "y", exposure: ["model"] }), undefined)).toBeNull();
  });
});

vdesc("replaceInputSchema / replaceOutputSchema / mapSchemas", () => {
  it("replaceInputSchema swaps inputSchema for named tools", () => {
    const t = replaceInputSchema({ x: widerSchema });
    const result = t.apply(tool({ name: "x" }), undefined);
    expect(result?.inputSchema).toBe(widerSchema);
  });

  it("replaceOutputSchema sets outputSchema even when previously absent", () => {
    const t = replaceOutputSchema({ x: widerSchema });
    const result = t.apply(tool({ name: "x" }), undefined);
    expect(result?.outputSchema).toBe(widerSchema);
  });

  it("mapSchemas applies the mapper to both", () => {
    const t = mapSchemas<unknown>({
      mapInput: () => widerSchema,
      mapOutput: (s) => s ?? widerSchema,
    });
    const result = t.apply(tool({ name: "x" }), undefined);
    expect(result?.inputSchema).toBe(widerSchema);
    expect(result?.outputSchema).toBe(widerSchema);
  });

  it("mapSchemas is a no-op when the mapper returns the same reference", () => {
    const input = tool({ name: "x" });
    const t = mapSchemas<unknown>({
      mapInput: (s) => s,
    });
    expect(t.apply(input, undefined)).toBe(input);
  });
});

vdesc("setMetadata / replaceMetadata", () => {
  it("setMetadata shallow-merges patches", () => {
    const t = setMetadata({ x: { audit: true } });
    const result = t.apply(tool({ name: "x", metadata: { existing: 1 } }), undefined);
    expect(result?.metadata).toEqual({ existing: 1, audit: true });
  });

  it("replaceMetadata replaces wholesale", () => {
    const t = replaceMetadata({ x: { fresh: true } });
    const result = t.apply(tool({ name: "x", metadata: { existing: 1 } }), undefined);
    expect(result?.metadata).toEqual({ fresh: true });
  });

  it("replaceMetadata(null) removes the metadata field entirely", () => {
    const t = replaceMetadata({ x: null });
    const result = t.apply(tool({ name: "x", metadata: { existing: 1 } }), undefined);
    expect(result?.metadata).toBeUndefined();
  });
});

vdesc("end-to-end MCP-server-shaped projection", () => {
  it("composes filter + rename + prefix + setTitle + setMetadata sanely", () => {
    interface Ctx {
      readonly user: { readonly role: string };
    }
    const projection = composeTransforms<Ctx>(
      onlyExposingTo<Ctx>("model"),
      deny<Ctx>([/^admin_/]),
      filter<Ctx>((t, ctx) => ctx.user.role !== "guest" || !t.metadata?.requiresAuth),
      rename<Ctx>({ internal_search: "search" }),
      prefix<Ctx>("public_"),
      setTitle<Ctx>({ public_search: "Search" }),
      setMetadata<Ctx>({ public_search: { audit: true } }),
    );

    const tools: ToolDeclaration[] = [
      tool({ name: "internal_search" }),
      tool({ name: "admin_destroy" }),
      tool({ name: "get_secret", metadata: { requiresAuth: true } }),
      tool({ name: "echo", exposure: ["dispatch"] }),
    ];

    const guestView = applyTransform(projection, tools, { user: { role: "guest" } });
    expect(guestView.map((t) => t.name)).toEqual(["public_search"]);
    expect(guestView[0]!.metadata).toEqual({ title: "Search", audit: true });

    const userView = applyTransform(projection, tools, { user: { role: "user" } });
    expect(userView.map((t) => t.name).sort()).toEqual(["public_get_secret", "public_search"]);
  });
});
