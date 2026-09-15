/**
 * The admission gate — `dispatchPolicy`, the sibling of `confirmationPolicy`
 * that decides whether a call is ADMITTED at all. Asked first: a veto never
 * reaches the confirmation gate, never runs a handler, and comes back to the
 * model as a soft error the shape of a denial.
 */
import { describe, expect, it } from "vitest";
import type { DispatchInput, ToolDispatchDecision, ToolRegistration } from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";
import * as blocks from "@agentick/spec/blocks";
import { createTestHarness } from "../testing/index.js";
import { speakOnlyForNonOwners, assertDispatchVerdict } from "../dispatch-policy.js";

function tool(
  name: string,
  annotations: ToolRegistration["declaration"]["annotations"] = {},
): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: name,
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["model"],
      annotations,
    },
    handlerRef: `h.${name}`,
    binding: { scope: "runtime" },
  };
}
const dispatchOf = (name: string, toolCallId: string): DispatchInput => ({
  toolCallId,
  name,
  input: {},
  context: { via: "model" },
});

describe("ToolExecutorHarness — dispatch admission policy", () => {
  it("a veto is a soft error carrying the reason; the handler never runs", async () => {
    const ran = { count: 0 };
    const seen: ToolDispatchDecision[] = [];
    const { harness } = await createTestHarness({
      tools: [tool("shred")],
      handlers: [
        { handlerRef: "h.shred", handler: async () => (ran.count++, [blocks.text("ok")]) },
      ],
      dispatchPolicy: (decision) => {
        seen.push(decision);
        return { kind: "veto", reason: "Linear is connected for Alice, not for you" };
      },
    });
    const result = await harness.dispatch(dispatchOf("shred", "tc-1"));
    expect(ran.count).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.executedBy).toBe("agentick");
    expect(result.durationMs).toBe(0);
    expect(result.content[0]).toEqual(
      blocks.text('Tool "shred" not permitted: Linear is connected for Alice, not for you'),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.declaration.name).toBe("shred");
    expect(seen[0]?.ctx.toolCallId).toBe("tc-1");
    await harness.close();
  });

  it("a vetoed call never reaches the confirmation gate — nothing is asked", async () => {
    const { harness, bus } = await createTestHarness({
      tools: [tool("delete-file", { requiresConfirmation: true })],
      handlers: [{ handlerRef: "h.delete-file", handler: async () => [blocks.text("gone")] }],
      dispatchPolicy: () => ({ kind: "veto" }),
    });
    let asked = 0;
    const { Effect, Stream } = await import("effect");
    void Effect.runPromise(
      Stream.runForEach(bus.subscribe({ name: { exact: "session:channel:elicitation" } }), () => {
        asked++;
        return Effect.void;
      }),
    ).catch(() => {});
    const result = await harness.dispatch(dispatchOf("delete-file", "tc-2"));
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      blocks.text('Tool "delete-file" not permitted for this turn.'),
    );
    expect(asked).toBe(0);
    await harness.close();
  });

  it("proceed runs the handler exactly as with no policy", async () => {
    const ran = { count: 0 };
    const { harness } = await createTestHarness({
      tools: [tool("echo")],
      handlers: [{ handlerRef: "h.echo", handler: async () => (ran.count++, [blocks.text("ok")]) }],
      dispatchPolicy: () => ({ kind: "proceed" }),
    });
    const result = await harness.dispatch(dispatchOf("echo", "tc-3"));
    expect(result.isError ?? false).toBe(false);
    expect(ran.count).toBe(1);
    await harness.close();
  });

  it("the default policy admits a turn with no actor, or whose actor is the owner, and vetoes any other", () => {
    const ctxOf = (principal?: string, actor?: string) => ({ principal, actor }) as never;
    const decision = (ctx: unknown) =>
      ({ declaration: tool("x").declaration, input: {}, ctx }) as never;
    expect(speakOnlyForNonOwners(decision(ctxOf("t:owner")))).toEqual({ kind: "proceed" });
    expect(speakOnlyForNonOwners(decision(ctxOf("t:owner", "t:owner")))).toEqual({
      kind: "proceed",
    });
    expect(speakOnlyForNonOwners(decision(ctxOf(undefined, undefined)))).toEqual({
      kind: "proceed",
    });
    expect(speakOnlyForNonOwners(decision(ctxOf("t:owner", "t:staff")))).toMatchObject({
      kind: "veto",
    });
  });

  it("a policy that answers anything but proceed or veto is a bug, not a soft error", async () => {
    const { harness } = await createTestHarness({
      tools: [tool("echo")],
      handlers: [{ handlerRef: "h.echo", handler: async () => [blocks.text("ok")] }],
      dispatchPolicy: () => ({ kind: "defer" }) as never,
    });
    await expect(harness.dispatch(dispatchOf("echo", "tc-4"))).rejects.toThrow(
      /answers \{ kind: "proceed" \}/,
    );
    expect(() => assertDispatchVerdict({ kind: "replace" }, "echo")).toThrow(
      /dispatchPolicy for "echo"/,
    );
    await harness.close();
  });
});
