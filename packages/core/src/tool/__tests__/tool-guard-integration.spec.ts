import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createTool } from "../tool";
import { createGuard, type ProcedureEnvelope, GuardError, isGuardError } from "@tentickle/kernel";

describe("createTool + guard integration", () => {
  const EchoTool = createTool({
    name: "echo",
    description: "Echoes input back",
    input: z.object({ text: z.string() }),
    handler: async ({ text }) => [{ type: "text" as const, text }],
  });

  it("guard captures envelope.metadata.toolName matching tool name", async () => {
    let captured: ProcedureEnvelope<any[]> | undefined;

    const spy = createGuard((envelope) => {
      captured = envelope;
      return true;
    });

    const guarded = EchoTool.run.use(spy);
    await guarded({ text: "hello" }).result;

    expect(captured).toBeDefined();
    expect(captured!.metadata.toolName).toBe("echo");
  });

  it("guard denial produces GuardError", async () => {
    const deny = createGuard({ name: "test-deny", reason: "not allowed" }, () => false);

    const guarded = EchoTool.run.use(deny);

    try {
      await guarded({ text: "hello" }).result;
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(isGuardError(err)).toBe(true);
      expect((err as GuardError).message).toBe("not allowed");
    }
  });

  it("tool executes normally when guard allows", async () => {
    const allow = createGuard(() => true);
    const guarded = EchoTool.run.use(allow);
    const result = await guarded({ text: "works" }).result;

    expect(result).toEqual([{ type: "text", text: "works" }]);
  });

  it("guard receives full metadata (type, toolName, id, operation)", async () => {
    let captured: ProcedureEnvelope<any[]> | undefined;

    const spy = createGuard((envelope) => {
      captured = envelope;
      return true;
    });

    const guarded = EchoTool.run.use(spy);
    await guarded({ text: "meta" }).result;

    expect(captured!.metadata).toMatchObject({
      type: "tool",
      toolName: "echo",
      id: "echo",
      operation: "run",
    });
  });
});
