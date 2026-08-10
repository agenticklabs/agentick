/**
 * The deployment-wide confirmation policy — the executor-level seam that
 * gets the FINAL say on whether the gate asks, composing with (never
 * replacing) each tool's own `requiresConfirmation` verdict.
 *
 * Force    → a tool with NO verdict of its own confirms because the policy
 *            says so (e.g. "every MCP tool not marked readOnlyHint: true").
 * Suppress → a tool that demanded confirmation runs straight through when
 *            the policy says a standing grant covers it.
 * Defer    → a policy returning `toolVerdict` is behavior-identical to no
 *            policy at all.
 */

import { describe, expect, it } from "vitest";
import { Chunk, Effect, Stream } from "effect";
import type { LocalEventBus } from "@agentick/runtime";

import type {
  DispatchInput,
  ProtocolEvent,
  ToolAnnotations,
  ToolConfirmationDecision,
  ToolRegistration,
} from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";

import { createTestHarness } from "../testing/index.js";

function tool(name: string, annotations: ToolAnnotations = {}): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: "test tool",
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["model"],
      annotations,
    },
    handlerRef: `h.${name}`,
    binding: { scope: "runtime" },
  };
}

/**
 * The shape a real deployment's policy is written in — the hints and the
 * provenance stamp are typed members, so no cast reaches them.
 */
function confirmsUnlessReadOnlyMcpTool({
  declaration,
  toolVerdict,
}: ToolConfirmationDecision): boolean {
  if (toolVerdict) return true;
  const annotations = declaration.annotations;
  return annotations?.executedBy?.startsWith("mcp:") === true
    ? annotations.readOnlyHint !== true
    : false;
}

const okHandler = (ran: { count: number }) => ({
  handlerRef: undefined as unknown as string,
  handler: async () => {
    ran.count++;
    return [{ type: "text" as const, text: "ok" }];
  },
});

function dispatchOf(name: string, toolCallId: string): DispatchInput {
  return { toolCallId, name, input: {}, context: { via: "model" } };
}

type EnvelopeWithMetadata = ProtocolEvent & {
  readonly metadata?: Readonly<Record<string, unknown>>;
};

function nextElicitationCorrelationId(bus: LocalEventBus): Promise<string> {
  return Effect.runPromise(
    Stream.runCollect(
      Stream.take(
        bus.subscribe({
          surface: "session",
          name: { exact: "session:channel:elicitation" },
        }) as Stream.Stream<EnvelopeWithMetadata, unknown, never>,
        1,
      ),
    ),
  ).then((chunk) => {
    const env = Array.from(Chunk.toReadonlyArray(chunk))[0]!;
    const id = env.metadata?.correlationId;
    if (typeof id !== "string") throw new Error("expected correlationId");
    return id;
  });
}

describe("ToolExecutorHarness — deployment-wide confirmation policy", () => {
  it("forces confirmation for a tool that did not ask for one (MCP-writes shape)", async () => {
    const ran = { count: 0 };
    const seen: ToolConfirmationDecision[] = [];
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [tool("create_todo", { executedBy: "mcp:knowify", readOnlyHint: false })],
      handlers: [{ ...okHandler(ran), handlerRef: "h.create_todo" }],
      confirmationPolicy: (decision) => {
        seen.push(decision);
        return confirmsUnlessReadOnlyMcpTool(decision);
      },
    });

    const idP = nextElicitationCorrelationId(bus);
    const dispatchP = harness.dispatch(dispatchOf("create_todo", "tc-1"));
    const correlationId = await idP;
    await elicitation.respond({
      correlationId,
      outcome: "accepted",
      value: { approved: true },
    });

    const result = await dispatchP;
    expect(result.isError ?? false).toBe(false);
    expect(ran.count).toBe(1);
    // The policy saw the tool's own (false) verdict and the annotations bag.
    const decision = seen[0]!;
    expect(decision.toolVerdict).toBe(false);
    expect(decision.declaration.annotations?.executedBy).toBe("mcp:knowify");
  });

  it("a read-only MCP tool passes the same policy without confirming", async () => {
    const ran = { count: 0 };
    const { harness } = await createTestHarness({
      tools: [tool("list_todos", { executedBy: "mcp:knowify", readOnlyHint: true })],
      handlers: [{ ...okHandler(ran), handlerRef: "h.list_todos" }],
      confirmationPolicy: confirmsUnlessReadOnlyMcpTool,
    });

    const result = await harness.dispatch(dispatchOf("list_todos", "tc-2"));
    expect(result.isError ?? false).toBe(false);
    expect(ran.count).toBe(1);
  });

  it("suppresses a tool's own requiresConfirmation when a standing grant covers it", async () => {
    const ran = { count: 0 };
    const granted = new Set(["delete_file"]);
    const { harness } = await createTestHarness({
      tools: [tool("delete_file", { requiresConfirmation: true })],
      handlers: [{ ...okHandler(ran), handlerRef: "h.delete_file" }],
      // The async form — a real policy hits a grants store.
      confirmationPolicy: async ({ declaration, toolVerdict }) =>
        granted.has(declaration.name) ? false : toolVerdict,
    });

    const result = await harness.dispatch(dispatchOf("delete_file", "tc-3"));
    expect(result.isError ?? false).toBe(false);
    expect(ran.count).toBe(1);
  });

  it("a deferring policy leaves an unannotated tool unconfirmed, exactly as before", async () => {
    const ran = { count: 0 };
    const { harness } = await createTestHarness({
      tools: [tool("plain")],
      handlers: [{ ...okHandler(ran), handlerRef: "h.plain" }],
      confirmationPolicy: ({ toolVerdict }) => toolVerdict,
    });

    const result = await harness.dispatch(dispatchOf("plain", "tc-4"));
    expect(result.isError ?? false).toBe(false);
    expect(ran.count).toBe(1);
  });
});
