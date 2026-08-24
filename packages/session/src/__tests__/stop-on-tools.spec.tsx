/**
 * `stopOnTools` end-to-end — the explicit-completion gate species driven
 * through a REAL send: SessionHarness + CompilerHarness + LoopExecutorHarness
 * + ToolExecutorHarness + the canonical {@link FakeLanguageModelExecutor},
 * with real handlers behind real `ToolDeclaration`s the scripted model calls.
 *
 * The gate reads the SETTLED tick (`TickResult.toolResults`), so the
 * load-bearing claim is the parallel-batch one: a three-call tick runs all
 * three handlers to completion and only THEN ends the turn.
 */

import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ElicitationHarness } from "@agentick/elicitation";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";
import { LoopExecutorHarness } from "@agentick/loop-executor";
import { CompilerHarness } from "@agentick/compiler-react";
import { stopOnTools } from "@agentick/gates";
import type {
  ExecutionTarget,
  LanguageModelExecutionResult,
  ToolCall,
  ToolDeclaration,
} from "@agentick/spec";
import { SPEC_VERSION, jsonSchema } from "@agentick/spec";

import { SessionHarness } from "../harness.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: false },
};

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

const callsTools = (...toolCalls: ToolCall[]): LanguageModelExecutionResult => ({
  specVersion: SPEC_VERSION,
  output: [],
  stopReason: "tool_use",
  usage,
  toolCalls,
});

const finalReply: LanguageModelExecutionResult = {
  specVersion: SPEC_VERSION,
  output: [{ type: "text", text: "finished" }],
  stopReason: "end",
  usage,
};

const declare = (name: string): ToolDeclaration => ({
  id: `t.${name}`,
  name,
  description: name,
  inputSchema: jsonSchema({ type: "object" }),
  exposure: ["model"],
  handlerRef: `h.${name}`,
});

interface Built {
  readonly session: SessionHarness;
  readonly tools: ToolExecutorHarness;
  readonly executor: FakeLanguageModelExecutor;
  /** Every tool name whose handler actually ran, in completion order. */
  readonly ran: string[];
  dispose(): Promise<void>;
}

/**
 * A session whose `search` / `done` / `write` tools are backed by real
 * handlers that record their own invocation.
 */
async function mkSession(scripts: readonly LanguageModelExecutionResult[]): Promise<Built> {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness("sot-r", journal, bus, inbox);
  const loop = new LoopExecutorHarness("sot-l", journal, bus, inbox);
  const resolver = new InMemoryHandlerResolver();
  const elicitation = new ElicitationHarness("sot-t:elic", journal, bus, inbox);
  const tools = new ToolExecutorHarness("sot-t", journal, bus, inbox, {
    handlerResolver: resolver,
    elicitation,
  });
  const executor = new FakeLanguageModelExecutor("sot-exec", journal, bus, inbox, {
    target,
    scripted: scripts.map((result) => ({ result })),
  });
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);

  const ran: string[] = [];
  for (const name of ["search", "done", "write"]) {
    resolver.register(`h.${name}`, async () => {
      ran.push(name);
      return [{ type: "text", text: `${name} ok` }];
    });
  }

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: `sot-${Math.random().toString(36).slice(2)}`,
    agent: null,
    compiler,
    loop,
    modelExecutor: executor,
    toolExecutor: tools,
    target,
    defaultStreaming: false,
  });
  await session.ready;
  await session.mountReady;

  return {
    session,
    tools,
    executor,
    ran,
    dispose: async () => {
      await session.close();
      await tools.close();
    },
  };
}

const send = (built: Built, toolNames: readonly string[]) =>
  built.session
    .send({
      messages: [{ role: "user", content: "go" }],
      tools: toolNames.map(declare),
      maxTicks: 5,
    })
    .then((h) => h.result);

describe("stopOnTools — a named tool ends the turn", () => {
  it("halts on the named tool, on a tick that would otherwise continue", async () => {
    const built = await mkSession([callsTools({ id: "c1", name: "done", input: {} }), finalReply]);
    built.session.gates.register("done", stopOnTools("done"));

    const result = await send(built, ["done"]);

    expect(built.ran).toEqual(["done"]);
    expect(result.stopReason).toBe("halted");
    expect(result.stopCause).toEqual({ kind: "halted", reason: "gate:done" });
    // The tool call alone would have carried the loop into tick 2; the second
    // script is never reached.
    expect(result.ticks).toBe(1);
    expect(built.executor.seenRuns).toHaveLength(1);

    await built.dispose();
  });

  it("a tool the gate does not name leaves the turn running", async () => {
    const built = await mkSession([
      callsTools({ id: "c1", name: "search", input: {} }),
      finalReply,
    ]);
    built.session.gates.register("done", stopOnTools("done"));

    const result = await send(built, ["search", "done"]);

    expect(built.ran).toEqual(["search"]);
    expect(result.ticks).toBe(2);
    expect(result.stopReason).not.toBe("halted");
    expect(result.stopCause).toBeUndefined();

    await built.dispose();
  });

  it("a parallel batch settles in full before the halt", async () => {
    const built = await mkSession([
      callsTools(
        { id: "c1", name: "search", input: {} },
        { id: "c2", name: "done", input: {} },
        { id: "c3", name: "write", input: {} },
      ),
      finalReply,
    ]);
    built.session.gates.register("done", stopOnTools("done"));

    const result = await send(built, ["search", "done", "write"]);

    expect([...built.ran].sort()).toEqual(["done", "search", "write"]);
    expect(result.toolResults.map((r) => r.toolName).sort()).toEqual(["done", "search", "write"]);
    expect(result.stopReason).toBe("halted");
    expect(result.stopCause).toEqual({ kind: "halted", reason: "gate:done" });
    expect(result.ticks).toBe(1);

    await built.dispose();
  });

  it("without the gate the same script runs on", async () => {
    const built = await mkSession([callsTools({ id: "c1", name: "done", input: {} }), finalReply]);

    const result = await send(built, ["done"]);

    expect(built.ran).toEqual(["done"]);
    expect(result.ticks).toBe(2);
    expect(result.stopReason).not.toBe("halted");
    expect(result.response).toBe("finished");

    await built.dispose();
  });
});
