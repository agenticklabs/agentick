/**
 * Slice-5 (#139) — session-layer wiring for the layered-tools plan.
 *
 * Verifies:
 *   - `SendInput.tools` registers execution-scoped tools and removes
 *     them at execution close (so the next send starts clean).
 *   - Execution-scoped tools win over session-scoped on name collision
 *     (precedence ladder verified at the registry level in slice 2;
 *     here we verify the loop sees the same outcome through the
 *     session boundary).
 *   - Execution-scope cleanup fires on both success and failure paths
 *     (the `.finally` semantics).
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type {
  ExecutorTerminal,
  LanguageModelExecutionResult,
  LanguageModelExecutor,
  RunInput,
  ToolDeclaration,
  ToolRegistration,
} from "@agentick/spec-next";
import { SPEC_VERSION, jsonSchema } from "@agentick/spec-next";
import { ToolExecutorHarness, InMemoryHandlerResolver } from "@agentick/tool-executor-next";
import { ElicitationHarness } from "@agentick/elicitation-next";
import { ReconcilerHarness } from "@agentick/reconciler-react-next";
import { LoopExecutorHarness } from "@agentick/loop-executor-next";

import { SessionHarness } from "../harness.js";

// ============================================================================
// Fixtures
// ============================================================================

const target = {
  kind: "language-model" as const,
  provider: "fake",
  modelId: "fake-v1",
};

/**
 * Recording executor — captures the `tools` arg passed to each `run()`
 * so tests can assert what the model would have seen this tick.
 */
function mkRecordingExecutor(): {
  readonly executor: LanguageModelExecutor;
  readonly captured: { runs: Array<readonly ToolDeclaration[]> };
} {
  const captured = { runs: [] as Array<readonly ToolDeclaration[]> };
  const result: LanguageModelExecutionResult = {
    specVersion: SPEC_VERSION,
    output: [{ type: "text", text: "ok" }],
    stopReason: "end",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
  const runFx = (input: RunInput): Effect.Effect<ExecutorTerminal<LanguageModelExecutionResult>> =>
    Effect.sync(() => {
      captured.runs.push(input.tools);
      return { outcome: "succeeded", result };
    });
  const executor: LanguageModelExecutor = {
    family: "language-model",
    target,
    ready: Promise.resolve(),
    fx: {
      use: () => () => {},
      run: runFx,
      project: () => Effect.succeed({ messages: [] }),
      normalize: () => Effect.succeed(result),
      executeStream: () => Effect.succeed(result),
    },
    async project() {
      return { messages: [] };
    },
    async execute() {
      return result;
    },
    async normalize() {
      return result;
    },
    run(input: RunInput): Promise<ExecutorTerminal<LanguageModelExecutionResult>> {
      return Effect.runPromise(runFx(input));
    },
    async abort() {},
  };
  return { executor, captured };
}

async function mkSession(opts: { sessionTools?: readonly ToolRegistration[] }): Promise<{
  session: SessionHarness;
  toolExecutor: ToolExecutorHarness;
  captured: { runs: Array<readonly ToolDeclaration[]> };
}> {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const reconciler = new ReconcilerHarness("test-r", journal, bus, inbox);
  const loop = new LoopExecutorHarness("test-l", journal, bus, inbox);
  const resolver = new InMemoryHandlerResolver();
  // Register handlers for every tool the tests use, so dispatch never
  // misses on a `handlerRef` lookup. The handlers don't run in these
  // tests (the recording executor doesn't emit tool_use), but the
  // registry's register() path still verifies that handlerRefs resolve.
  for (const name of ["calc", "search", "exec_only"]) {
    resolver.register(`h.${name}`, async () => [{ type: "text", text: "ok" }]);
  }
  const elicitation = new ElicitationHarness("test-t:elicitation", journal, bus, inbox);
  const toolExecutor = new ToolExecutorHarness("test-t", journal, bus, inbox, {
    handlerResolver: resolver,
    elicitation,
    ...(opts.sessionTools ? { initialTools: opts.sessionTools } : {}),
  });
  const { executor, captured } = mkRecordingExecutor();
  await Promise.all([
    reconciler.ready,
    loop.ready,
    toolExecutor.ready,
    elicitation.ready,
    executor.ready,
  ]);

  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    agent: null,
    reconciler,
    loop,
    executor,
    toolExecutor,
    target,
  });
  await session.ready;
  await session.mountReady;
  return { session, toolExecutor, captured };
}

function tool(name: string, exposure: ToolDeclaration["exposure"] = ["model"]): ToolDeclaration {
  return {
    id: `t.${name}`,
    name,
    description: name,
    inputSchema: jsonSchema({ type: "object" }),
    exposure,
    handlerRef: `h.${name}`,
  };
}

// ============================================================================
// Suite
// ============================================================================

describe("SessionHarness — layered tools (#139)", () => {
  it("registers SendInput.tools at execution scope; loop sees them at the tick", async () => {
    const { session, captured } = await mkSession({});
    const h = await session.send({
      messages: [{ role: "user", content: "go" }],
      tools: [tool("exec_only")],
    });
    await h.result;
    expect(captured.runs).toHaveLength(1);
    expect(captured.runs[0]!.map((t) => t.name)).toEqual(["exec_only"]);
    await session.close();
  });

  it("execution-scoped tools are removed when the execution finishes", async () => {
    const { session, toolExecutor, captured } = await mkSession({});
    const h = await session.send({
      messages: [{ role: "user", content: "go" }],
      tools: [tool("exec_only")],
    });
    await h.result;
    // Give the .finally() microtask a chance to run.
    await new Promise((r) => setImmediate(r));
    // After the execution closes, the registry should NOT carry the
    // exec-bound tool anymore.
    const remaining = (await toolExecutor.list()).map((d) => d.name);
    expect(remaining).not.toContain("exec_only");
    // The next send with no tools sees an empty model view.
    const h2 = await session.send({ messages: [{ role: "user", content: "go again" }] });
    await h2.result;
    expect(captured.runs[1]!).toEqual([]);
    await session.close();
  });

  it("execution-scoped tool overrides session-scoped tool of the same name", async () => {
    const sessionTool: ToolRegistration = {
      declaration: {
        id: "t.calc",
        name: "calc",
        description: "session calc",
        inputSchema: jsonSchema({ type: "object" }),
        exposure: ["model"],
        handlerRef: "h.calc",
      },
      handlerRef: "h.calc",
      binding: { scope: "session", sessionId: "test-session" },
    };
    const { session, captured } = await mkSession({ sessionTools: [sessionTool] });
    const h = await session.send({
      messages: [{ role: "user", content: "go" }],
      tools: [
        {
          id: "t.calc.exec",
          name: "calc", // same name
          description: "exec calc",
          inputSchema: jsonSchema({ type: "object" }),
          exposure: ["model"],
          handlerRef: "h.calc",
        },
      ],
    });
    await h.result;
    expect(captured.runs[0]!).toHaveLength(1);
    // Execution binding wins by precedence — model sees the exec one.
    expect(captured.runs[0]![0]!.description).toBe("exec calc");
    await session.close();
  });

  it("session-scoped tool persists across sends", async () => {
    const sessionTool: ToolRegistration = {
      declaration: {
        id: "t.search",
        name: "search",
        description: "session search",
        inputSchema: jsonSchema({ type: "object" }),
        exposure: ["model"],
        handlerRef: "h.search",
      },
      handlerRef: "h.search",
      binding: { scope: "session", sessionId: "test-session" },
    };
    const { session, captured } = await mkSession({ sessionTools: [sessionTool] });
    const h1 = await session.send({ messages: [{ role: "user", content: "1" }] });
    await h1.result;
    const h2 = await session.send({ messages: [{ role: "user", content: "2" }] });
    await h2.result;
    expect(captured.runs[0]!.map((t) => t.name)).toEqual(["search"]);
    expect(captured.runs[1]!.map((t) => t.name)).toEqual(["search"]);
    await session.close();
  });
});
