/**
 * WireExtensionRegistry — unit tests for register / resolve / enumerate /
 * seal. Doubles as the reference behavior spec — anyone building a
 * remote registry (e.g., a cluster-broadcast registry that merges
 * remote-node extensions) can start here.
 */

import { describe, expect, it } from "vitest";
import { defineWireExtension, WireExtensionDefinitionError } from "@agentick/spec";

import { createWireExtensionRegistry } from "../wire-registry.js";

// TypeScript declaration-merge — the tests use fabricated wire method
// names ("test/*", "other/*"). Merge them into WireMethods so the
// extension bodies typecheck.
declare module "@agentick/spec" {
  interface WireMethods {
    "test/list": { params: object; result: { items: readonly string[] } };
    "test/get": { params: { id: string }; result: { id: string } };
    "other/list": { params: object; result: { items: readonly string[] } };
  }
  interface WireNotifications {
    "test/changed": { readonly id: string };
    "test/added": { readonly id: string };
  }
}

function buildTestExtension() {
  return defineWireExtension({
    name: "@test/first",
    namespace: "test",
    version: "1.0.0",
    methods: {
      "test/list": async () => ({ items: ["a", "b"] }),
      "test/get": async ({ id }) => ({ id }),
    },
    notifications: ["test/changed", "test/added"],
  });
}

function buildOtherExtension() {
  return defineWireExtension({
    name: "@test/second",
    namespace: "other",
    methods: {
      "other/list": async () => ({ items: ["x"] }),
    },
  });
}

describe("createWireExtensionRegistry", () => {
  it("registers an extension and resolves its methods", async () => {
    const registry = createWireExtensionRegistry();
    const ext = buildTestExtension();
    registry.register(ext);

    const resolvedList = registry.resolve("test/list");
    expect(resolvedList).toBeDefined();
    expect(resolvedList!.extension).toBe(ext);
    const result = await resolvedList!.handler({}, {});
    expect(result).toEqual({ items: ["a", "b"] });

    const resolvedGet = registry.resolve("test/get");
    expect(resolvedGet).toBeDefined();
    const getResult = await resolvedGet!.handler({ id: "42" }, {});
    expect(getResult).toEqual({ id: "42" });
  });

  it("returns undefined for unresolved methods", () => {
    const registry = createWireExtensionRegistry();
    registry.register(buildTestExtension());
    expect(registry.resolve("nonexistent/method")).toBeUndefined();
  });

  it("enumerates registered extensions in insertion order", () => {
    const registry = createWireExtensionRegistry();
    registry.register(buildTestExtension());
    registry.register(buildOtherExtension());

    const entries = registry.enumerate();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      name: "@test/first",
      namespace: "test",
      version: "1.0.0",
      methods: expect.arrayContaining(["test/list", "test/get"]),
      notifications: ["test/changed", "test/added"],
    });
    expect(entries[1]).toMatchObject({
      name: "@test/second",
      namespace: "other",
      methods: ["other/list"],
      notifications: [],
    });
    // Version omitted when the extension didn't declare one.
    expect(entries[1]).not.toHaveProperty("version");
  });

  it("throws on duplicate namespace", () => {
    const registry = createWireExtensionRegistry();
    registry.register(buildTestExtension());
    const dup = defineWireExtension({
      name: "@test/dup-namespace",
      namespace: "test",
      methods: {
        "test/list": async () => ({ items: [] }),
      },
    });
    expect(() => registry.register(dup)).toThrow(WireExtensionDefinitionError);
    expect(() => registry.register(dup)).toThrow(/namespace "test" already registered/);
  });

  it("throws on duplicate extension name", () => {
    const registry = createWireExtensionRegistry();
    registry.register(buildTestExtension());
    const dup = defineWireExtension({
      // Same `name` as buildTestExtension, different namespace.
      name: "@test/first",
      namespace: "other",
      methods: {
        "other/list": async () => ({ items: [] }),
      },
    });
    expect(() => registry.register(dup)).toThrow(WireExtensionDefinitionError);
    expect(() => registry.register(dup)).toThrow(
      /extension name "@test\/first" already registered/,
    );
  });

  it("register throws once sealed", () => {
    const registry = createWireExtensionRegistry();
    registry.register(buildTestExtension());
    registry.seal();
    expect(() => registry.register(buildOtherExtension())).toThrow(WireExtensionDefinitionError);
    expect(() => registry.register(buildOtherExtension())).toThrow(/registry is sealed/);
  });

  it("resolve + enumerate still work after seal", () => {
    const registry = createWireExtensionRegistry();
    registry.register(buildTestExtension());
    registry.seal();
    expect(registry.resolve("test/list")).toBeDefined();
    expect(registry.enumerate()).toHaveLength(1);
  });
});
