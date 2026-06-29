/**
 * Tools-slot trichotomy — ADR 42 Slice 2 contract.
 *
 * The `tools` slot accepts three authoring patterns that all collapse
 * to the same internal `{registry, resolveHandler, filter, transforms}`
 * pair via `resolveToolsOption`:
 *
 *   1. `CreatedTool[]` — array shorthand
 *   2. `{ tools: CreatedTool[], filter?, transforms? }` — config object
 *      with inline tools
 *   3. `{ registry, resolveHandler, filter?, transforms? }` — low-level
 *      escape hatch (custom handler resolution / dynamic registries)
 *
 * Form B (a `Tools` instance via `use:`) is intentionally absent —
 * blocked on `DispatchInput.ctxOverride` spec evolution. See ADR 42
 * audit row.
 *
 * @verifiedBy ADR 42 Slice 2 + `McpServerToolsOptions` (config.ts)
 */

import { describe, expect, it } from "vitest";
import {
  jsonSchema,
  McpServerConfigInvalid,
  type McpRequestContext,
  type ToolDeclaration,
} from "@agentick/spec-next";
import { createTool } from "@agentick/tool-next";

import { resolveToolsOption } from "../config.js";

const stringSchema = jsonSchema({ type: "object" });

function decl(name: string, handlerRef: string): ToolDeclaration {
  return {
    id: name,
    name,
    description: `desc:${name}`,
    inputSchema: stringSchema,
    exposure: ["model"],
    handlerRef,
  };
}

describe("resolveToolsOption — form A: CreatedTool[] shorthand", () => {
  it("builds registry from declarations + resolver from handlers", async () => {
    const echo = createTool({
      name: "echo",
      description: "echo",
      handler: async () => [{ type: "text", text: "ok" }],
    });
    const resolved = resolveToolsOption([echo]);
    expect(resolved.registry).toEqual([echo.declaration]);
    expect(resolved.filter).toBeNull();
    expect(resolved.transforms).toEqual([]);

    const handler = resolved.resolveHandler(echo.handlerRef);
    expect(handler).not.toBeNull();
    const result = await handler!({}, fakeCtx());
    expect(result).toEqual([{ type: "text", text: "ok" }]);
  });

  it("returns null for unknown handlerRef", () => {
    const t = createTool({
      name: "x",
      description: "x",
      handler: async () => [],
    });
    const resolved = resolveToolsOption([t]);
    expect(resolved.resolveHandler("nonexistent.ref")).toBeNull();
  });

  it("rejects non-CreatedTool entries", () => {
    expect(() =>
      resolveToolsOption([{ name: "bare" } as unknown as ReturnType<typeof createTool>]),
    ).toThrow(McpServerConfigInvalid);
  });
});

describe("resolveToolsOption — form C: config object with inline tools", () => {
  it("accepts tools + filter + transforms", () => {
    const t = createTool({
      name: "x",
      description: "x",
      handler: async () => [],
    });
    const filter = (): boolean => true;
    const resolved = resolveToolsOption({ tools: [t], filter });
    expect(resolved.registry).toEqual([t.declaration]);
    expect(resolved.filter).toBe(filter);
  });

  it("rejects an empty config (no source)", () => {
    expect(() => resolveToolsOption({} as never)).toThrow(McpServerConfigInvalid);
  });

  it("rejects mixed `tools` + `registry` authoring patterns", () => {
    const t = createTool({ name: "x", description: "x", handler: async () => [] });
    expect(() =>
      resolveToolsOption({
        tools: [t],
        registry: [decl("y", "ref:y")],
        resolveHandler: () => null,
      }),
    ).toThrow(McpServerConfigInvalid);
  });
});

describe("resolveToolsOption — form C: low-level registry + resolveHandler", () => {
  it("passes through the canonical pair unchanged", () => {
    const reg = [decl("a", "ref:a")];
    const resolver = (): null => null;
    const resolved = resolveToolsOption({ registry: reg, resolveHandler: resolver });
    expect(resolved.registry).toBe(reg);
    expect(resolved.resolveHandler).toBe(resolver);
  });

  it("rejects registry without resolveHandler", () => {
    expect(() => resolveToolsOption({ registry: [] } as never)).toThrow(McpServerConfigInvalid);
  });

  it("rejects resolveHandler without registry", () => {
    expect(() => resolveToolsOption({ resolveHandler: () => null } as never)).toThrow(
      McpServerConfigInvalid,
    );
  });
});

function fakeCtx(): McpRequestContext {
  return {
    toolCallId: "tc-1",
    signal: new AbortController().signal,
    task: "auto",
    transport: "mcp",
    setState: () => {},
    emit: () => {},
    mcp: {
      serverId: "srv:test",
      connectionId: "conn:test",
      transportKind: "in-memory",
      connectedAt: 0,
      user: null,
      clientInfo: null,
      clientCapabilities: null,
    },
    metadata: {},
  };
}
