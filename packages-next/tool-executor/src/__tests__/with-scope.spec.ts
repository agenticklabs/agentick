/**
 * `withScope` — scoped binding lifecycle around a caller-supplied
 * async body. Verifies register-each + run + removeBoundTools-in-
 * finally semantics.
 */

import { describe, expect, it } from "vitest";
import type { ToolDeclaration } from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";

import { createTestHarness } from "../testing/index.js";
import { withScope } from "../with-scope.js";

const decl = (name: string): ToolDeclaration => ({
  id: `t.${name}`,
  name,
  description: name,
  inputSchema: jsonSchema({ type: "object" }),
  exposure: ["model"],
  handlerRef: `h.${name}`,
});

describe("withScope", () => {
  it("binds declarations for the body and cleans up after", async () => {
    const { harness } = await createTestHarness();
    const inside = await withScope(
      harness,
      { scope: "execution", executionId: "e1" },
      [decl("foo"), decl("bar")],
      async () => {
        return (await harness.list()).map((d) => d.name).sort();
      },
    );
    expect(inside).toEqual(["bar", "foo"]);
    // After return, the execution scope's tools are gone.
    expect((await harness.list()).map((d) => d.name)).toEqual([]);
  });

  it("cleans up on throw", async () => {
    const { harness } = await createTestHarness();
    await expect(
      withScope(harness, { scope: "execution", executionId: "e2" }, [decl("foo")], async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Cleanup still ran.
    expect((await harness.list()).map((d) => d.name)).toEqual([]);
  });

  it("empty declarations runs body without registration", async () => {
    const { harness } = await createTestHarness();
    const result = await withScope(
      harness,
      { scope: "execution", executionId: "e3" },
      [],
      async () => "ok",
    );
    expect(result).toBe("ok");
    expect((await harness.list()).map((d) => d.name)).toEqual([]);
  });

  it("does not disturb tools bound at other scopes", async () => {
    const { harness } = await createTestHarness({
      tools: [
        {
          declaration: decl("app_tool"),
          handlerRef: "h.app_tool",
          binding: { scope: "app", appId: "a1" },
        },
      ],
    });
    expect((await harness.list()).map((d) => d.name)).toEqual(["app_tool"]);
    await withScope(
      harness,
      { scope: "execution", executionId: "e4" },
      [decl("exec_tool")],
      async () => {
        const names = (await harness.list()).map((d) => d.name).sort();
        expect(names).toEqual(["app_tool", "exec_tool"]);
      },
    );
    // After cleanup, only the app tool remains.
    expect((await harness.list()).map((d) => d.name)).toEqual(["app_tool"]);
  });

  it("returns whatever the body returns", async () => {
    const { harness } = await createTestHarness();
    const value = await withScope(
      harness,
      { scope: "execution", executionId: "e5" },
      [decl("x")],
      async () => ({ ok: true, count: 42 }),
    );
    expect(value).toEqual({ ok: true, count: 42 });
  });
});
