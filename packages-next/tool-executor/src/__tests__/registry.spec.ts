import { describe, expect, it } from "vitest";
import type { ToolRegistration } from "@agentick/spec-next";
import { ToolAlreadyRegistered, jsonSchema } from "@agentick/spec-next";
import { InMemoryToolRegistry } from "../registry.js";

function reg(name: string, overrides: Partial<ToolRegistration> = {}): ToolRegistration {
  return {
    declaration: {
      id: overrides.declaration?.id ?? name,
      name,
      description: overrides.declaration?.description ?? `tool ${name}`,
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["model", "dispatch"],
      ...(overrides.declaration ?? {}),
    },
    handlerRef: overrides.handlerRef ?? `h.${name}`,
    ...(overrides.useDeps ? { useDeps: overrides.useDeps } : {}),
    binding: overrides.binding ?? { scope: "runtime" },
  };
}

describe("InMemoryToolRegistry", () => {
  it("add + get round-trip", () => {
    const r = new InMemoryToolRegistry();
    r.add(reg("calc.add"));
    expect(r.get("calc.add")?.declaration.name).toBe("calc.add");
    expect(r.has("calc.add")).toBe(true);
    expect(r.has("missing")).toBe(false);
  });

  it("add is idempotent on identical shape", () => {
    const r = new InMemoryToolRegistry();
    r.add(reg("a"));
    r.add(reg("a"));
    expect(r.size()).toBe(1);
  });

  it("add throws ToolAlreadyRegistered on shape conflict", () => {
    const r = new InMemoryToolRegistry();
    r.add(reg("a"));
    expect(() => r.add(reg("a", { handlerRef: "h.different" }))).toThrowError(
      expect.objectContaining(new ToolAlreadyRegistered({ name: "a" })),
    );
  });

  it("remove drops the entry; subsequent get returns undefined", () => {
    const r = new InMemoryToolRegistry();
    r.add(reg("a"));
    r.remove("a");
    expect(r.get("a")).toBeUndefined();
    expect(r.size()).toBe(0);
  });

  it("remove on unknown name is a no-op", () => {
    const r = new InMemoryToolRegistry();
    r.remove("never-registered");
    expect(r.size()).toBe(0);
  });

  it("list returns every declaration", () => {
    const r = new InMemoryToolRegistry();
    r.add(reg("a"));
    r.add(reg("b"));
    const names = r
      .list()
      .map((d) => d.name)
      .sort();
    expect(names).toEqual(["a", "b"]);
  });

  it("list filters by exposure", () => {
    const r = new InMemoryToolRegistry();
    r.add(
      reg("model-only", {
        declaration: {
          id: "model-only",
          description: "x",
          inputSchema: jsonSchema({}),
          name: "model-only",
          exposure: ["model"],
        },
      }),
    );
    r.add(
      reg("dispatch-only", {
        declaration: {
          id: "dispatch-only",
          description: "x",
          inputSchema: jsonSchema({}),
          name: "dispatch-only",
          exposure: ["dispatch"],
        },
      }),
    );
    expect(r.list({ exposure: "model" }).map((d) => d.name)).toEqual(["model-only"]);
    expect(r.list({ exposure: "dispatch" }).map((d) => d.name)).toEqual(["dispatch-only"]);
  });

  it("list filters by intent", () => {
    const r = new InMemoryToolRegistry();
    r.add(
      reg("a", {
        declaration: {
          id: "a",
          description: "x",
          inputSchema: jsonSchema({}),
          name: "a",
          exposure: ["dispatch"],
          annotations: { intent: "render" },
        },
      }),
    );
    r.add(reg("b"));
    const renderTools = r.list({ intent: "render" }).map((d) => d.name);
    expect(renderTools).toEqual(["a"]);
  });

  it("list filters by name regex", () => {
    const r = new InMemoryToolRegistry();
    r.add(reg("calc.add"));
    r.add(reg("calc.sub"));
    r.add(reg("fs.read"));
    const calc = r
      .list({ nameMatches: "^calc\\." })
      .map((d) => d.name)
      .sort();
    expect(calc).toEqual(["calc.add", "calc.sub"]);
  });

  it("clear drops everything", () => {
    const r = new InMemoryToolRegistry();
    r.add(reg("a"));
    r.add(reg("b"));
    r.clear();
    expect(r.size()).toBe(0);
    expect(r.names()).toEqual([]);
  });
});
