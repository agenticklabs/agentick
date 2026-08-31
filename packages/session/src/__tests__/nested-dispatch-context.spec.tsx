/**
 * A tool dispatched BY a tool inherits the calling dispatch's context.
 *
 * The failure this pins: `tool_dispatch` reaching a hidden tool, whose handler
 * then resolved a credential by principal and found none — because the nested
 * dispatch began as a context-free root op. A tool handler is a Promise, so the
 * ambient operation is gone by the time it calls `ctx.tools.dispatch`; the
 * handle it holds is bound to the caller's runtime so the work composes back
 * inside the calling dispatch instead of starting fresh.
 */

import React from "react";
import { describe, expect, it } from "vitest";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { CompilerHarness, System } from "@agentick/compiler-react";
import type { ExecutionTarget, ToolHandlerCtx } from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";
import { SessionHarness } from "../harness.js";

const PRINCIPAL = "8580:32728";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "m",
  capabilities: { supportsTools: true, supportsStreaming: false, contextWindow: 1000 },
};

const decl = (name: string) => ({
  id: name,
  name,
  description: name,
  inputSchema: jsonSchema({ type: "object" }),
  exposure: ["model" as const],
  handlerRef: `h.${name}`,
});

describe("a tool dispatched by a tool", () => {
  it("inherits the calling dispatch's context, not a fresh root one", async () => {
    const seen: Record<string, Partial<ToolHandlerCtx>> = {};
    const record =
      (who: string) =>
      async (_i: unknown, { ctx }: { ctx: ToolHandlerCtx }) => {
        seen[who] = {
          principal: ctx.principal,
          sessionId: ctx.sessionId,
          executionId: ctx.executionId,
          tickId: ctx.tickId,
        };
        return [{ type: "text" as const, text: "ok" }];
      };

    const j = new MemoryJournal(),
      b = new LocalEventBus(),
      i = new LocalInbox();
    const compiler = new CompilerHarness("nd-r", j, b, i);
    const loop = new LoopExecutorHarness("nd-l", j, b, i);
    const resolver = new InMemoryHandlerResolver();
    resolver.register("h.inner", record("inner"));
    resolver.register("h.outer", async (_i: unknown, { ctx }: { ctx: ToolHandlerCtx }) => {
      await record("outer")(_i, { ctx });
      // Exactly what `tool_dispatch` does for a hidden tool.
      await ctx.tools!.dispatch("inner", {}, { via: "model" });
      return [{ type: "text" as const, text: "ok" }];
    });

    const el = new ElicitationHarness("nd-t:e", j, b, i);
    const tools = new ToolExecutorHarness("nd-t", j, b, i, {
      handlerResolver: resolver,
      elicitation: el,
      principal: PRINCIPAL,
    });
    const ex = new FakeLanguageModelExecutor("nd-e", j, b, i, {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "c" }],
            toolCalls: [{ id: "t1", name: "outer", input: {} }],
            stopReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        },
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "d" }],
            stopReason: "end",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        },
      ],
    });
    await Promise.all([compiler.ready, loop.ready, tools.ready, el.ready, ex.ready]);

    const session = new SessionHarness(j, b, i, {
      sessionId: "nd-s",
      principal: PRINCIPAL,
      agent: React.createElement(() => React.createElement(System, null, "hi")),
      compiler,
      loop,
      modelExecutor: ex,
      toolExecutor: tools,
      target,
    });
    await session.ready;
    await session.mountReady;
    const handle = await session.send({
      messages: [{ role: "user", content: "hi" }],
      tools: [decl("outer"), decl("inner")],
    });
    await handle.result;

    // The whole point: the nested call is not a context-free root op.
    expect(seen.inner).toEqual(seen.outer);
    expect(seen.inner?.principal).toBe(PRINCIPAL);
    expect(seen.inner?.executionId).toBe(seen.outer?.executionId);
    expect(seen.inner?.tickId).toBe(seen.outer?.tickId);
  });
});
