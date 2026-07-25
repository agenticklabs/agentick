/**
 * Slice-2 (#136) — layered tool config registry semantics.
 *
 * Validates that the in-memory registry:
 *   1. Stores multiple registrations per name, one per binding slice.
 *   2. Resolves name collisions in `compileForTick` via the layered
 *      precedence ladder.
 *   3. Applies `replaceCompilerSlice` atomically (removes the
 *      compiler slice for a mountId, leaves other slices untouched).
 *   4. Honors filter-before-precedence semantics (a high-precedence
 *      registration that fails the filter doesn't shadow a lower-
 *      precedence registration that passes).
 *   5. `get(name)` returns the highest-precedence registration —
 *      ensures the dispatch path lands on the same handler the model
 *      saw via `compileForTick`.
 */

import { describe, expect, it } from "vitest";
import type { ToolBinding, ToolDeclaration, ToolRegistration } from "@agentick/spec";
import { ToolAlreadyRegistered, jsonSchema } from "@agentick/spec";

import { InMemoryToolRegistry } from "../registry.js";
import { omitUndefined } from "@agentick/utils";

function mkDecl(name: string, overrides: Partial<ToolDeclaration> = {}): ToolDeclaration {
  return {
    id: overrides.id ?? name,
    name,
    description: overrides.description ?? name,
    inputSchema: overrides.inputSchema ?? jsonSchema({ type: "object" }),
    exposure: overrides.exposure ?? ["model"],
    ...omitUndefined({
      outputSchema: overrides.outputSchema,
      handlerRef: overrides.handlerRef,
      annotations: overrides.annotations,
      metadata: overrides.metadata,
    }),
  };
}

function reg(
  name: string,
  binding: ToolBinding,
  overrides?: {
    handlerRef?: string;
    useDeps?: Readonly<Record<string, unknown>>;
    declaration?: Partial<ToolDeclaration>;
  },
): ToolRegistration {
  return {
    declaration: mkDecl(name, overrides?.declaration),
    handlerRef: overrides?.handlerRef ?? `h.${name}.${binding.scope}`,
    binding,
    ...(overrides?.useDeps !== undefined ? { useDeps: overrides.useDeps } : {}),
  };
}

describe("InMemoryToolRegistry — layered tools (#136)", () => {
  describe("multi-binding storage", () => {
    it("same name + same binding key is idempotent on equal shape", () => {
      const r = new InMemoryToolRegistry();
      r.add(reg("foo", { scope: "session", sessionId: "s1" }));
      r.add(reg("foo", { scope: "session", sessionId: "s1" }));
      expect(r.totalRegistrations()).toBe(1);
    });

    it("same name + same binding key throws on shape mismatch", () => {
      const r = new InMemoryToolRegistry();
      r.add(reg("foo", { scope: "session", sessionId: "s1" }));
      expect(() =>
        r.add(reg("foo", { scope: "session", sessionId: "s1" }, { handlerRef: "h.different" })),
      ).toThrow(ToolAlreadyRegistered);
    });

    it("same name + different binding adds a sibling", () => {
      const r = new InMemoryToolRegistry();
      r.add(reg("foo", { scope: "runtime" }));
      r.add(reg("foo", { scope: "session", sessionId: "s1" }));
      r.add(reg("foo", { scope: "compiler", mountId: "m1" }));
      expect(r.totalRegistrations()).toBe(3);
      expect(r.size()).toBe(1); // one distinct name
    });

    it("list returns one declaration per (name, binding) pair", () => {
      const r = new InMemoryToolRegistry();
      r.add(reg("foo", { scope: "session", sessionId: "s1" }));
      r.add(reg("foo", { scope: "compiler", mountId: "m1" }));
      r.add(reg("bar", { scope: "app", appId: "a1" }));
      expect(r.list()).toHaveLength(3);
    });
  });

  describe("compileForTick — precedence resolution", () => {
    it("compiler binding wins over execution", () => {
      const r = new InMemoryToolRegistry();
      r.add(reg("foo", { scope: "execution", executionId: "e1" }, { handlerRef: "h.exec" }));
      r.add(reg("foo", { scope: "compiler", mountId: "m1" }, { handlerRef: "h.compiler" }));
      const compiled = r.compileForTick();
      expect(compiled).toHaveLength(1);
      expect(compiled[0]!.name).toBe("foo");
      expect(r.get("foo")?.handlerRef).toBe("h.compiler");
    });

    it("execution wins over session", () => {
      const r = new InMemoryToolRegistry();
      r.add(reg("foo", { scope: "session", sessionId: "s1" }, { handlerRef: "h.session" }));
      r.add(reg("foo", { scope: "execution", executionId: "e1" }, { handlerRef: "h.exec" }));
      expect(r.get("foo")?.handlerRef).toBe("h.exec");
    });

    it("session wins over app", () => {
      const r = new InMemoryToolRegistry();
      r.add(reg("foo", { scope: "app", appId: "a1" }, { handlerRef: "h.app" }));
      r.add(reg("foo", { scope: "session", sessionId: "s1" }, { handlerRef: "h.session" }));
      expect(r.get("foo")?.handlerRef).toBe("h.session");
    });

    it("app wins over gateway", () => {
      const r = new InMemoryToolRegistry();
      r.add(reg("foo", { scope: "gateway" }, { handlerRef: "h.gateway" }));
      r.add(reg("foo", { scope: "app", appId: "a1" }, { handlerRef: "h.app" }));
      expect(r.get("foo")?.handlerRef).toBe("h.app");
    });

    it("gateway wins over runtime", () => {
      const r = new InMemoryToolRegistry();
      r.add(reg("foo", { scope: "runtime" }, { handlerRef: "h.runtime" }));
      r.add(reg("foo", { scope: "gateway" }, { handlerRef: "h.gateway" }));
      expect(r.get("foo")?.handlerRef).toBe("h.gateway");
    });

    it("extension at level=app sits alongside app (extension wins on tie order — first-wins is tested via reverse-order separately)", () => {
      // Extension@app and app share precedence rank 2. The implementation
      // picks the FIRST registration encountered with the highest rank
      // (LinkedHashMap iteration order). Tests below verify both orders
      // yield deterministic winners — both inputs have the same precedence,
      // so the contract is "either wins, but consistently for a given
      // insertion order."
      const r1 = new InMemoryToolRegistry();
      r1.add(reg("foo", { scope: "app", appId: "a1" }, { handlerRef: "h.app" }));
      r1.add(
        reg(
          "foo",
          { scope: "extension", extensionName: "@x/y", level: "app" },
          { handlerRef: "h.ext" },
        ),
      );
      // First with highest rank wins (here both have rank 2; "h.app" was
      // first inserted at rank 2).
      expect(r1.get("foo")?.handlerRef).toBe("h.app");

      const r2 = new InMemoryToolRegistry();
      r2.add(
        reg(
          "foo",
          { scope: "extension", extensionName: "@x/y", level: "app" },
          { handlerRef: "h.ext" },
        ),
      );
      r2.add(reg("foo", { scope: "app", appId: "a1" }, { handlerRef: "h.app" }));
      expect(r2.get("foo")?.handlerRef).toBe("h.ext");
    });

    it("filter applies BEFORE precedence — high-rank fails filter, low-rank passes wins", () => {
      const r = new InMemoryToolRegistry();
      // Session-bound (rank 3), model+dispatch — would win if filter passed
      r.add(
        reg(
          "foo",
          { scope: "session", sessionId: "s1" },
          {
            declaration: { name: "foo", exposure: ["dispatch"] },
            handlerRef: "h.session-dispatch-only",
          },
        ),
      );
      // App-bound (rank 2), model — lower rank but matches `exposure: "model"`
      r.add(
        reg(
          "foo",
          { scope: "app", appId: "a1" },
          {
            declaration: { name: "foo", exposure: ["model"] },
            handlerRef: "h.app-model",
          },
        ),
      );
      const compiled = r.compileForTick({ exposure: "model" });
      expect(compiled).toHaveLength(1);
      expect(compiled[0]!.name).toBe("foo");
      // The session-bound entry would win by precedence but doesn't match
      // the filter — the app-bound entry wins instead.
      expect(compiled[0]!.exposure).toEqual(["model"]);
    });

    it("compileForTick filters by intent", () => {
      const r = new InMemoryToolRegistry();
      r.add(
        reg(
          "foo",
          { scope: "runtime" },
          {
            declaration: { name: "foo", annotations: { intent: "render" } },
          },
        ),
      );
      r.add(
        reg(
          "bar",
          { scope: "runtime" },
          {
            declaration: { name: "bar", annotations: { intent: "action" } },
          },
        ),
      );
      const renderOnly = r.compileForTick({ intent: "render" });
      expect(renderOnly).toHaveLength(1);
      expect(renderOnly[0]!.name).toBe("foo");
    });
  });

  describe("replaceCompilerSlice", () => {
    it("removes prior compiler entries with same mountId and adds new ones", () => {
      const r = new InMemoryToolRegistry();
      r.replaceCompilerSlice("m1", [
        reg("foo", { scope: "compiler", mountId: "m1" }),
        reg("bar", { scope: "compiler", mountId: "m1" }),
      ]);
      expect(r.size()).toBe(2);

      // Second replace drops `bar`, keeps `foo`, adds `baz`.
      r.replaceCompilerSlice("m1", [
        reg("foo", { scope: "compiler", mountId: "m1" }),
        reg("baz", { scope: "compiler", mountId: "m1" }),
      ]);
      expect(r.names()).toEqual(["baz", "foo"]);
    });

    it("does not touch non-compiler bindings", () => {
      const r = new InMemoryToolRegistry();
      r.add(reg("session-tool", { scope: "session", sessionId: "s1" }));
      r.add(reg("app-tool", { scope: "app", appId: "a1" }));
      r.replaceCompilerSlice("m1", [reg("rendered", { scope: "compiler", mountId: "m1" })]);

      // Now replace with empty — only compiler slice for m1 should clear.
      r.replaceCompilerSlice("m1", []);
      expect(r.has("session-tool")).toBe(true);
      expect(r.has("app-tool")).toBe(true);
      expect(r.has("rendered")).toBe(false);
    });

    it("does not touch compiler bindings for OTHER mountIds", () => {
      const r = new InMemoryToolRegistry();
      r.replaceCompilerSlice("m1", [reg("m1-tool", { scope: "compiler", mountId: "m1" })]);
      r.replaceCompilerSlice("m2", [reg("m2-tool", { scope: "compiler", mountId: "m2" })]);
      r.replaceCompilerSlice("m1", []); // clear m1's slice only
      expect(r.has("m1-tool")).toBe(false);
      expect(r.has("m2-tool")).toBe(true);
    });

    it("rejects registrations whose binding doesn't match the supplied mountId", () => {
      const r = new InMemoryToolRegistry();
      expect(() =>
        r.replaceCompilerSlice("m1", [reg("bad", { scope: "compiler", mountId: "m2" })]),
      ).toThrowError(/binding/);
    });

    it("rejects registrations whose binding scope isn't 'compiler'", () => {
      const r = new InMemoryToolRegistry();
      expect(() =>
        r.replaceCompilerSlice("m1", [reg("bad", { scope: "session", sessionId: "s1" })]),
      ).toThrowError(/binding/);
    });
  });

  describe("removeWhere", () => {
    it("removes only entries whose binding matches the predicate", () => {
      const r = new InMemoryToolRegistry();
      r.add(reg("a", { scope: "session", sessionId: "s1" }));
      r.add(reg("b", { scope: "session", sessionId: "s2" }));
      r.add(reg("c", { scope: "app", appId: "a1" }));
      r.removeWhere((b) => b.scope === "session" && b.sessionId === "s1");
      expect(r.names()).toEqual(["b", "c"]);
    });

    it("removes a name entirely when its only remaining binding matches", () => {
      const r = new InMemoryToolRegistry();
      r.add(reg("foo", { scope: "session", sessionId: "s1" }));
      r.removeWhere((b) => b.scope === "session" && b.sessionId === "s1");
      expect(r.has("foo")).toBe(false);
      expect(r.size()).toBe(0);
    });

    it("keeps a name when only some bindings match the predicate", () => {
      const r = new InMemoryToolRegistry();
      r.add(reg("foo", { scope: "session", sessionId: "s1" }));
      r.add(reg("foo", { scope: "app", appId: "a1" }));
      r.removeWhere((b) => b.scope === "session" && b.sessionId === "s1");
      expect(r.has("foo")).toBe(true);
      expect(r.totalRegistrations()).toBe(1);
      expect(r.get("foo")?.binding.scope).toBe("app");
    });
  });

  // The prefix-cache ordering guarantee (three-audiences-plan §B2). Tools
  // serialize at the head of the provider prompt, so a per-execution tool
  // binding is a prefix perturbation. `compileForTick` stably partitions
  // execution-scoped winners to the TAIL so the cache-stable tree/compiler
  // prefix keeps hitting; the loop then appends the structured-output terminal
  // tool after this projection (last of all).
  describe("compileForTick — execution bindings serialize at the tail", () => {
    it("execution-scoped tools come after every non-execution tool, stable otherwise", () => {
      const r = new InMemoryToolRegistry();
      // Interleave insertion order: exec, compiler, exec, session.
      r.add(reg("exec_a", { scope: "execution", executionId: "e1" }));
      r.add(reg("compiler_a", { scope: "compiler", mountId: "m1" }));
      r.add(reg("exec_b", { scope: "execution", executionId: "e1" }));
      r.add(reg("session_a", { scope: "session", sessionId: "s1" }));

      const names = r.compileForTick({ exposure: "model" }).map((d) => d.name);
      // Non-execution winners keep insertion order at the head; execution
      // winners keep insertion order at the tail.
      expect(names).toEqual(["compiler_a", "session_a", "exec_a", "exec_b"]);
    });

    it("an execution winner (over a session sibling of the same name) still sorts to the tail", () => {
      const r = new InMemoryToolRegistry();
      r.add(reg("shared", { scope: "session", sessionId: "s1" }));
      r.add(reg("shared", { scope: "execution", executionId: "e1" })); // higher precedence
      r.add(reg("compiler_a", { scope: "compiler", mountId: "m1" }));

      const names = r.compileForTick({ exposure: "model" }).map((d) => d.name);
      // `shared` resolves to its execution binding → tail, after the compiler tool.
      expect(names).toEqual(["compiler_a", "shared"]);
    });
  });
});
