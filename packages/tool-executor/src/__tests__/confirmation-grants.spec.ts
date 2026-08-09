/**
 * Standing confirmation grants — the two halves that make `always: true`
 * mean something beyond the current process.
 *
 *   - `onConfirmationResolved` — every ask reports how it settled
 *     (approved / denied / timeout), which is where an adopter writes the
 *     grant its `confirmationPolicy` will later read. An observer that
 *     throws is an observer that fails alone.
 *   - `exportSnapshot` / `importSnapshot` — the in-session grant set is
 *     session state, so it round-trips through a session snapshot.
 */

import { describe, expect, it } from "vitest";
import { Chunk, Effect, Stream } from "effect";
import type { LocalEventBus } from "@agentick/runtime";

import type {
  DispatchInput,
  ProtocolEvent,
  ToolConfirmationResolution,
  ToolRegistration,
} from "@agentick/spec";
import { ToolConfirmationTimeoutError, jsonSchema } from "@agentick/spec";

import { createTestHarness } from "../testing/index.js";

function confirmTool(name = "delete-file"): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: "risky",
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["model"],
      annotations: { requiresConfirmation: true },
    },
    handlerRef: `h.${name}`,
    binding: { scope: "runtime" },
  };
}

function dispatchOf(
  toolCallId: string,
  input: unknown = {},
  overrides: Partial<DispatchInput> = {},
): DispatchInput {
  return {
    toolCallId,
    name: "delete-file",
    input,
    context: { via: "model" },
    ...overrides,
  };
}

const okHandler = (ran: { count: number }) => ({
  handlerRef: "h.delete-file",
  handler: async () => {
    ran.count++;
    return [{ type: "text" as const, text: "ok" }];
  },
});

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

describe("ToolExecutorHarness — onConfirmationResolved", () => {
  it("an always-approval reports the grant, the tool, and the session that issued it", async () => {
    const ran = { count: 0 };
    const seen: ToolConfirmationResolution[] = [];
    const { harness, bus, elicitation } = await createTestHarness({
      scopeId: "sess-grant",
      tools: [confirmTool()],
      handlers: [okHandler(ran)],
      onConfirmationResolved: (r) => {
        seen.push(r);
      },
    });

    const idP = nextElicitationCorrelationId(bus);
    const dispatchP = harness.dispatch(dispatchOf("tc-1", { path: "/tmp/risky" }));
    await elicitation.respond({
      correlationId: await idP,
      outcome: "accepted",
      value: { approved: true, always: true },
    });
    await dispatchP;

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      toolUseId: "tc-1",
      toolName: "delete-file",
      sessionId: "sess-grant",
      outcome: "approved",
      always: true,
      arguments: { path: "/tmp/risky" },
    });
    expect(ran.count).toBe(1);
  });

  it("a one-off approval carries no grant, and an edit rides as modifiedArguments", async () => {
    const ran = { count: 0 };
    const seen: ToolConfirmationResolution[] = [];
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [okHandler(ran)],
      onConfirmationResolved: (r) => {
        seen.push(r);
      },
    });

    const idP = nextElicitationCorrelationId(bus);
    const dispatchP = harness.dispatch(dispatchOf("tc-2", { path: "/tmp/risky" }));
    await elicitation.respond({
      correlationId: await idP,
      outcome: "accepted",
      value: { approved: true, modifiedArguments: { path: "/tmp/safe" } },
    });
    await dispatchP;

    expect(seen[0]!.outcome).toBe("approved");
    expect(seen[0]!.always).toBeUndefined();
    // `arguments` is what was ASKED about; the edit is reported separately.
    expect(seen[0]!.arguments).toEqual({ path: "/tmp/risky" });
    expect(seen[0]!.modifiedArguments).toEqual({ path: "/tmp/safe" });
  });

  it("a denial and an expiry reach the observer, told apart by outcome", async () => {
    const seen: ToolConfirmationResolution[] = [];
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [okHandler({ count: 0 })],
      onConfirmationResolved: (r) => {
        seen.push(r);
      },
    });

    const idP = nextElicitationCorrelationId(bus);
    const deniedP = harness.dispatch(dispatchOf("tc-3"));
    await elicitation.respond({
      correlationId: await idP,
      outcome: "declined",
      reason: "not today",
    });
    await deniedP;

    await expect(
      harness.dispatch(dispatchOf("tc-4", {}, { confirmationTimeoutMs: 25 })),
    ).rejects.toBeInstanceOf(ToolConfirmationTimeoutError);

    expect(seen.map((r) => r.outcome)).toEqual(["denied", "timeout"]);
    expect(seen[0]!.reason).toContain("not today");
    expect(seen[1]!.toolUseId).toBe("tc-4");
  });

  it("a grant the executor already holds is not re-reported — no ask, no resolution", async () => {
    const ran = { count: 0 };
    const seen: ToolConfirmationResolution[] = [];
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [okHandler(ran)],
      onConfirmationResolved: (r) => {
        seen.push(r);
      },
    });

    const idP = nextElicitationCorrelationId(bus);
    const first = harness.dispatch(dispatchOf("tc-5"));
    await elicitation.respond({
      correlationId: await idP,
      outcome: "accepted",
      value: { approved: true, always: true },
    });
    await first;

    await harness.dispatch(dispatchOf("tc-6"));

    expect(ran.count).toBe(2);
    expect(seen).toHaveLength(1);
  });

  it("a throwing observer does not fail the dispatch it reports on", async () => {
    const ran = { count: 0 };
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [okHandler(ran)],
      onConfirmationResolved: () => {
        throw new Error("grant store is down");
      },
    });

    const idP = nextElicitationCorrelationId(bus);
    const dispatchP = harness.dispatch(dispatchOf("tc-7"));
    await elicitation.respond({
      correlationId: await idP,
      outcome: "accepted",
      value: { approved: true },
    });

    const result = await dispatchP;
    expect(result.isError ?? false).toBe(false);
    expect(ran.count).toBe(1);
  });

  it("a rejecting async observer does not fail the dispatch either", async () => {
    const ran = { count: 0 };
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [okHandler(ran)],
      onConfirmationResolved: async () => {
        await Promise.reject(new Error("grant store is down"));
      },
    });

    const idP = nextElicitationCorrelationId(bus);
    const dispatchP = harness.dispatch(dispatchOf("tc-8"));
    await elicitation.respond({
      correlationId: await idP,
      outcome: "accepted",
      value: { approved: true },
    });

    const result = await dispatchP;
    expect(result.isError ?? false).toBe(false);
    expect(ran.count).toBe(1);
  });
});

describe("ToolExecutorHarness — grant snapshot", () => {
  it("export → import moves a standing grant onto a fresh executor", async () => {
    const ran = { count: 0 };
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [okHandler(ran)],
    });

    const idP = nextElicitationCorrelationId(bus);
    const first = harness.dispatch(dispatchOf("tc-9"));
    await elicitation.respond({
      correlationId: await idP,
      outcome: "accepted",
      value: { approved: true, always: true },
    });
    await first;

    expect(harness.exportSnapshot()).toEqual({ alwaysAllowed: ["delete-file"] });

    const restoredRan = { count: 0 };
    const { harness: restored } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [okHandler(restoredRan)],
    });
    restored.importSnapshot(harness.exportSnapshot());

    // Nobody answers an elicitation here — the gate must not raise one.
    const result = await restored.dispatch(dispatchOf("tc-10"));
    expect(result.isError ?? false).toBe(false);
    expect(restoredRan.count).toBe(1);
  });

  it("import replaces the grant set rather than merging into it", async () => {
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [okHandler({ count: 0 })],
    });

    const idP = nextElicitationCorrelationId(bus);
    const first = harness.dispatch(dispatchOf("tc-11"));
    await elicitation.respond({
      correlationId: await idP,
      outcome: "accepted",
      value: { approved: true, always: true },
    });
    await first;

    harness.importSnapshot({ alwaysAllowed: [] });
    expect(harness.exportSnapshot()).toEqual({ alwaysAllowed: [] });
  });
});
