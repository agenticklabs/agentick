/**
 * `createToolsHandle` — the server-side `session.tools` View + host-door
 * dispatch + topology subscription (three-audiences-plan §F).
 *
 * Exercises the handle against a REAL {@link InMemoryToolRegistry} (list/get/has
 * + exposure filter + ToolInfo projection + name-then-alias + subscribe
 * topology) with a spy dispatch closure.
 */

import { describe, expect, it, vi } from "vitest";
import type { ContentBlock, ToolRegistration } from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";
import { InMemoryToolRegistry } from "../registry.js";
import { createToolsHandle } from "../tools-handle.js";

function reg(
  name: string,
  overrides: Partial<ToolRegistration["declaration"]> = {},
  binding: ToolRegistration["binding"] = { scope: "runtime" },
): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: `tool ${name}`,
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["model", "dispatch"],
      ...overrides,
    },
    handlerRef: `h.${name}`,
    binding,
  };
}

function harnessOverRegistry(registry: InMemoryToolRegistry) {
  const dispatch = vi.fn(
    async (_name: string, _input: unknown): Promise<readonly ContentBlock[]> => [
      { type: "text", text: "ok" },
    ],
  );
  const handle = createToolsHandle({
    compileSync: (filter) => registry.compileForTick(filter),
    getSync: (name) => registry.get(name),
    dispatch,
    subscribe: (l) => registry.subscribe(l),
  });
  return { handle, dispatch };
}

describe("createToolsHandle (server session.tools)", () => {
  it("list() projects one wire-safe ToolInfo per name (no live schema)", () => {
    const r = new InMemoryToolRegistry();
    r.add(reg("calc.add", { aliases: ["add"] }));
    r.add(reg("calc.sub"));
    const { handle } = harnessOverRegistry(r);

    const infos = handle.list();
    expect(infos.map((i) => i.name).sort()).toEqual(["calc.add", "calc.sub"]);
    const add = infos.find((i) => i.name === "calc.add")!;
    expect(add.description).toBe("tool calc.add");
    expect(add.exposure).toEqual(["model", "dispatch"]);
    expect(add.aliases).toEqual(["add"]);
    expect(add.hasInputSchema).toBe(true);
    // The live StandardSchema validator never crosses into the projection.
    expect((add as unknown as Record<string, unknown>).inputSchema).toBeUndefined();
  });

  it("list({ exposure }) filters to the matching door", () => {
    const r = new InMemoryToolRegistry();
    r.add(reg("model-only", { exposure: ["model"] }));
    r.add(reg("dispatch-only", { exposure: ["dispatch"] }));
    const { handle } = harnessOverRegistry(r);

    expect(handle.list({ exposure: "dispatch" }).map((i) => i.name)).toEqual(["dispatch-only"]);
    expect(handle.list({ exposure: "model" }).map((i) => i.name)).toEqual(["model-only"]);
  });

  it("get(name) resolves by name then alias and binds dispatch to the canonical name", async () => {
    const r = new InMemoryToolRegistry();
    r.add(reg("calc.add", { aliases: ["add"] }));
    const { handle, dispatch } = harnessOverRegistry(r);

    expect(handle.get("calc.add")?.name).toBe("calc.add");
    const viaAlias = handle.get("add");
    expect(viaAlias?.name).toBe("calc.add"); // canonical, not the alias
    expect(handle.get("missing")).toBeUndefined();

    await viaAlias!.dispatch({ a: 1 });
    expect(dispatch).toHaveBeenCalledWith("calc.add", { a: 1 }, undefined);
  });

  it("has(name) covers names and aliases", () => {
    const r = new InMemoryToolRegistry();
    r.add(reg("calc.add", { aliases: ["add"] }));
    const { handle } = harnessOverRegistry(r);
    expect(handle.has("calc.add")).toBe(true);
    expect(handle.has("add")).toBe(true);
    expect(handle.has("missing")).toBe(false);
  });

  it("dispatch(name, input, opts) forwards to the host-door dispatch", async () => {
    const r = new InMemoryToolRegistry();
    r.add(reg("echo"));
    const { handle, dispatch } = harnessOverRegistry(r);
    const out = await handle.dispatch("echo", { x: 1 }, { task: "ref" });
    expect(out).toEqual([{ type: "text", text: "ok" }]);
    expect(dispatch).toHaveBeenCalledWith("echo", { x: 1 }, { task: "ref" });
  });

  it("subscribeAll fires on any registry topology change", () => {
    const r = new InMemoryToolRegistry();
    const { handle } = harnessOverRegistry(r);
    const seen = vi.fn();
    const off = handle.subscribeAll(seen);
    r.add(reg("a"));
    r.add(reg("b"));
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    r.add(reg("c"));
    expect(seen).toHaveBeenCalledTimes(2); // detached
  });

  it("subscribe(name) fires only for that name (and bulk changes)", () => {
    const r = new InMemoryToolRegistry();
    r.add(reg("a"));
    const { handle } = harnessOverRegistry(r);
    const seen = vi.fn();
    handle.subscribe("a", seen);
    r.add(reg("b")); // different name — no fire
    expect(seen).toHaveBeenCalledTimes(0);
    r.remove("a"); // that name — fires
    expect(seen).toHaveBeenCalledTimes(1);
    r.clear(); // bulk (undefined) — fires
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
