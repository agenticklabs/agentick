/**
 * Per-execution tool RESTRICTION — `SendInput.allowedTools` (C2,
 * three-audiences-plan §C split, item 3).
 *
 * When a send carries `allowedTools`, the loop filters the MERGED,
 * precedence-resolved model-visible tool list down to the allowlisted canonical
 * names — applied AFTER the compiler-tools merge, BEFORE structured-output
 * terminal-tool injection. Dispatch-door tools are unaffected (the restriction
 * scopes only what the MODEL sees). The post-restriction count feeds the `"auto"`
 * structured-output strategy resolution.
 *
 * Mechanism-tier, scripted through the canonical {@link FakeLanguageModelExecutor}
 * on its non-streaming `fx.run` path (`defaultStreaming: false`), whose
 * `seenRuns` ledger records each tick's model-facing `tools` list.
 *
 * @verifiedBy this suite — the `SendInput.allowedTools` → loop-filter seam.
 * @see docs/proposals/v2/three-audiences-plan.md §C
 */

import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type {
  ExecutionTarget,
  LanguageModelExecutionResult,
  StandardSchemaV1,
  ToolDeclaration,
  ToolRegistration,
} from "@agentick/spec-next";
import { SPEC_VERSION, jsonSchema } from "@agentick/spec-next";
import { FakeLanguageModelExecutor } from "@agentick/model-executor-next";
import { ToolExecutorHarness, InMemoryHandlerResolver } from "@agentick/tool-executor-next";
import { ElicitationHarness } from "@agentick/elicitation-next";
import { CompilerHarness } from "@agentick/compiler-react-next";
import { LoopExecutorHarness } from "@agentick/loop-executor-next";

import { SessionHarness } from "../harness.js";

// ============================================================================
// Fixtures
// ============================================================================

/** OpenAI-like: native tools AND native json_schema — auto with 0 tools →
 *  responseFormat, with ≥1 tools → terminal tool. */
const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true, supportsJsonSchema: true },
};

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;

const textResult = (text: string): LanguageModelExecutionResult => ({
  specVersion: SPEC_VERSION,
  output: [{ type: "text", text }],
  stopReason: "end",
  usage,
});

const terminalCallResult = (input: Record<string, unknown>): LanguageModelExecutionResult => ({
  specVersion: SPEC_VERSION,
  output: [{ type: "tool_use", toolUseId: "tc-term", name: "submit_result", input }],
  stopReason: "tool_use",
  usage,
  toolCalls: [{ id: "tc-term", name: "submit_result", input }],
});

/** `{ answer: string }` schema with a real validator. */
const answerSchema: StandardSchemaV1<unknown, { answer: string }> = jsonSchema<{ answer: string }>(
  { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
  {
    validator: (v) =>
      typeof (v as { answer?: unknown })?.answer === "string"
        ? { value: v as { answer: string } }
        : { issues: [{ message: "answer must be a string" }] },
  },
);

/** The model-facing tools the fake saw this tick. */
const seenTools = (executor: FakeLanguageModelExecutor, tick: number): readonly ToolDeclaration[] =>
  executor.seenRuns[tick]!.tools ?? [];
const seenNames = (executor: FakeLanguageModelExecutor, tick: number): string[] =>
  seenTools(executor, tick).map((t) => t.name);

function sessionTool(
  name: string,
  exposure: ToolDeclaration["exposure"] = ["model"],
): ToolRegistration {
  return {
    declaration: {
      id: `t.${name}`,
      name,
      description: name,
      inputSchema: jsonSchema({ type: "object" }),
      exposure,
      handlerRef: `h.${name}`,
    },
    handlerRef: `h.${name}`,
    binding: { scope: "session", sessionId: "restriction-test" },
  };
}

async function mkSession(opts: {
  readonly sessionTools?: readonly ToolRegistration[];
  readonly scripts: readonly LanguageModelExecutionResult[];
}): Promise<{
  session: SessionHarness;
  executor: FakeLanguageModelExecutor;
  dispose: () => Promise<void>;
}> {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const compiler = new CompilerHarness("tr-r", journal, bus, inbox);
  const loop = new LoopExecutorHarness("tr-l", journal, bus, inbox);
  const resolver = new InMemoryHandlerResolver();
  for (const name of ["calc", "search", "echo"]) {
    resolver.register(`h.${name}`, async () => [{ type: "text", text: `${name}-ok` }]);
  }
  const elicitation = new ElicitationHarness("tr-t:elic", journal, bus, inbox);
  const tools = new ToolExecutorHarness("tr-t", journal, bus, inbox, {
    handlerResolver: resolver,
    elicitation,
    ...(opts.sessionTools ? { initialTools: opts.sessionTools } : {}),
  });
  const executor = new FakeLanguageModelExecutor("tr-exec", journal, bus, inbox, {
    target,
    scripted: opts.scripts.map((result) => ({ result })),
  });
  await Promise.all([compiler.ready, loop.ready, tools.ready, elicitation.ready, executor.ready]);
  const session = new SessionHarness(journal, bus, inbox, {
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
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
    executor,
    dispose: async () => {
      await session.close();
      await tools.close();
    },
  };
}

// ============================================================================
// Suite
// ============================================================================

describe("SendInput.allowedTools — restriction reaches the model", () => {
  it("exposes ONLY allowlisted tools to the model; the rest are filtered", async () => {
    const { session, executor, dispose } = await mkSession({
      sessionTools: [sessionTool("calc", ["model", "dispatch"]), sessionTool("search", ["model"])],
      scripts: [textResult("done")],
    });

    await (
      await session.send({
        messages: [{ role: "user", content: "go" }],
        allowedTools: ["search"],
      })
    ).result;

    // Only `search` reached the model; `calc` was filtered out of the model view.
    expect(seenNames(executor, 0)).toEqual(["search"]);
    await dispose();
  });

  it("with NO allowedTools, every mounted model tool reaches the model (control)", async () => {
    const { session, executor, dispose } = await mkSession({
      sessionTools: [sessionTool("calc", ["model"]), sessionTool("search", ["model"])],
      scripts: [textResult("done")],
    });

    await (
      await session.send({ messages: [{ role: "user", content: "go" }] })
    ).result;

    expect(seenNames(executor, 0).sort()).toEqual(["calc", "search"]);
    await dispose();
  });

  it("the dispatch door is UNAFFECTED — a non-allowlisted tool still dispatches", async () => {
    const { session, executor, dispose } = await mkSession({
      // `calc` is dispatch-reachable but excluded from the model this send.
      sessionTools: [sessionTool("calc", ["model", "dispatch"]), sessionTool("search", ["model"])],
      scripts: [textResult("done")],
    });

    await (
      await session.send({
        messages: [{ role: "user", content: "go" }],
        allowedTools: ["search"],
      })
    ).result;
    expect(seenNames(executor, 0)).toEqual(["search"]);

    // The host door reaches `calc` despite it never being exposed to the model.
    const content = await session.tools.dispatch("calc", {});
    expect(content[0]).toMatchObject({ type: "text", text: "calc-ok" });
    await dispose();
  });

  it("composes with SendInput.tools (additive): an exec tool must ALSO be named to reach the model", async () => {
    const { session, executor, dispose } = await mkSession({ scripts: [textResult("done")] });

    await (
      await session.send({
        messages: [{ role: "user", content: "go" }],
        tools: [
          {
            id: "t.echo",
            name: "echo",
            description: "echo",
            inputSchema: jsonSchema({ type: "object" }),
            exposure: ["model"],
            handlerRef: "h.echo",
          },
          {
            id: "t.calc",
            name: "calc",
            description: "calc",
            inputSchema: jsonSchema({ type: "object" }),
            exposure: ["model"],
            handlerRef: "h.calc",
          },
        ],
        // Only `echo` is allowlisted — the exec-scoped `calc` is filtered.
        allowedTools: ["echo"],
      })
    ).result;

    expect(seenNames(executor, 0)).toEqual(["echo"]);
    await dispose();
  });
});

describe("SendInput.allowedTools — interaction with structured output (§B2)", () => {
  it("the terminal tool is EXEMPT: present despite not being allowlisted; result still delivered", async () => {
    const { session, executor, dispose } = await mkSession({
      sessionTools: [sessionTool("calc", ["model"]), sessionTool("search", ["model"])],
      scripts: [terminalCallResult({ answer: "approved" })],
    });

    const r = await (
      await session.send({
        messages: [{ role: "user", content: "go" }],
        allowedTools: ["search"],
        output: answerSchema,
      })
    ).result;

    const names = seenNames(executor, 0);
    // Restriction kept `search`, dropped `calc` — but the loop-injected terminal
    // tool is exempt (injected AFTER restriction).
    expect(names).toContain("search");
    expect(names).not.toContain("calc");
    expect(names).toContain("submit_result");
    // ≥1 tool survives restriction ⇒ auto strategy = terminal tool.
    expect(names[names.length - 1]).toBe("submit_result");
    // Structured result delivered + validated.
    expect(r.data).toEqual({ answer: "approved" });
    expect(r.stopReason).toBe("output_delivered");
    await dispose();
  });

  it("restriction to an EMPTY set feeds auto as toolsMounted=false → responseFormat overlay", async () => {
    const { session, executor, dispose } = await mkSession({
      sessionTools: [sessionTool("calc", ["model"]), sessionTool("search", ["model"])],
      scripts: [textResult('{"answer":"empty"}')],
    });

    const r = await (
      await session.send({
        messages: [{ role: "user", content: "go" }],
        // Allowlist matches nothing mounted → the post-restriction model list is
        // empty, so `"auto"` resolves as if no tools were mounted.
        allowedTools: ["nonexistent"],
        output: answerSchema,
      })
    ).result;

    const names = seenNames(executor, 0);
    // Empty model tool list — no real tools, and (json-schema-capable target) NO
    // terminal tool: the responseFormat strategy won instead.
    expect(names).not.toContain("calc");
    expect(names).not.toContain("search");
    expect(names).not.toContain("submit_result");
    expect(executor.seenRuns[0]!.compiled.config?.responseFormat).toBeDefined();
    // The final text is parsed + validated loop-side.
    expect(r.data).toEqual({ answer: "empty" });
    await dispose();
  });
});
