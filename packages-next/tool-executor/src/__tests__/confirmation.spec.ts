/**
 * Confirmation flow tests — refactored onto ElicitationHarness.
 *
 * Tools declared `annotations.requiresConfirmation: true` pause after
 * validation and elicit a structured response via the session's
 * `ElicitationHarness` (wire channel `session:channel:elicitation`).
 * Tests subscribe to the bus to capture the outbound elicitation
 * request envelope (which carries the correlationId in metadata),
 * then deliver the response via `elicitation.respond(...)`.
 *
 * Approve  → `accepted` with `value.approved: true` → handler runs
 *            (`modifiedArguments` re-validated when set).
 * Deny     → `accepted` with `value.approved: false` OR `declined` /
 *            `cancelled` outcome → DispatchResult{ isError: true } (ADR 70).
 * Abort    → controller signal fires → elicit() resolves to
 *            `{ outcome: "failed", failure.kind: "aborted" }` →
 *            denial-shaped result with reason from the failure.
 * Timeout  → elicit() resolves to `{ outcome: "failed",
 *            failure.kind: "timeout" }` → `ToolConfirmationTimeoutError`
 *            (typed failure surfaces to the dispatch caller).
 */

import { describe, expect, it } from "vitest";
import { Chunk, Effect, Stream } from "effect";
import type { LocalEventBus } from "@agentick/runtime-next";

import type { DispatchInput, ProtocolEvent, ToolRegistration } from "@agentick/spec-next";
import { ToolConfirmationTimeoutError, jsonSchema } from "@agentick/spec-next";

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
  name: string,
  toolCallId: string,
  input: unknown = {},
  overrides: Partial<DispatchInput> = {},
): DispatchInput {
  return {
    toolCallId,
    name,
    input,
    context: { via: "model" },
    ...overrides,
  };
}

type EnvelopeWithMetadata = ProtocolEvent & {
  readonly metadata?: Readonly<Record<string, unknown>>;
};

/**
 * Wait for the next elicitation request envelope on
 * `session:channel:elicitation` and return its correlationId. The
 * subscription is hot before this returns — call this BEFORE
 * `harness.dispatch(...)` so the bus has a subscriber by the time
 * the confirmation gate publishes.
 */
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
    if (typeof id !== "string") {
      throw new Error("expected correlationId on elicitation request envelope");
    }
    return id;
  });
}

describe("ToolExecutorHarness — confirmation flow (via ElicitationHarness)", () => {
  it("approve: handler runs after accepted response", async () => {
    let handlerRan = 0;
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [
        {
          handlerRef: "h.delete-file",
          handler: async () => {
            handlerRan++;
            return [{ type: "text", text: "deleted" }];
          },
        },
      ],
    });

    const idP = nextElicitationCorrelationId(bus);
    const dispatchP = harness.dispatch(dispatchOf("delete-file", "tc-1"));
    const correlationId = await idP;
    await elicitation.respond({
      correlationId,
      outcome: "accepted",
      value: { approved: true },
    });

    const result = await dispatchP;
    expect(result.isError ?? false).toBe(false);
    expect(handlerRan).toBe(1);
    expect((result.content[0] as { text: string }).text).toBe("deleted");
  });

  it("deny via accepted+approved:false: isError=true; handler never runs", async () => {
    let handlerRan = 0;
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [
        {
          handlerRef: "h.delete-file",
          handler: async () => {
            handlerRan++;
            return [{ type: "text", text: "deleted" }];
          },
        },
      ],
    });

    const idP = nextElicitationCorrelationId(bus);
    const dispatchP = harness.dispatch(dispatchOf("delete-file", "tc-2"));
    const correlationId = await idP;
    await elicitation.respond({
      correlationId,
      outcome: "accepted",
      value: { approved: false, reason: "user said no" },
    });

    const result = await dispatchP;
    expect(result.isError).toBe(true);
    expect(handlerRan).toBe(0);
    expect((result.content[0] as { text: string }).text).toContain("denied");
    expect((result.content[0] as { text: string }).text).toContain("user said no");
  });

  it("deny via declined outcome: isError=true; reason flows through", async () => {
    let handlerRan = 0;
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [
        {
          handlerRef: "h.delete-file",
          handler: async () => {
            handlerRan++;
            return [{ type: "text", text: "deleted" }];
          },
        },
      ],
    });

    const idP = nextElicitationCorrelationId(bus);
    const dispatchP = harness.dispatch(dispatchOf("delete-file", "tc-decline"));
    const correlationId = await idP;
    await elicitation.respond({
      correlationId,
      outcome: "declined",
      reason: "user clicked Deny",
    });

    const result = await dispatchP;
    expect(result.isError).toBe(true);
    expect(handlerRan).toBe(0);
    expect((result.content[0] as { text: string }).text).toContain("user clicked Deny");
  });

  it("modifiedArguments: handler receives the edited input", async () => {
    let receivedInput: unknown = null;
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [
        {
          handlerRef: "h.delete-file",
          handler: async (input) => {
            receivedInput = input;
            return [{ type: "text", text: "ok" }];
          },
        },
      ],
    });

    const idP = nextElicitationCorrelationId(bus);
    const dispatchP = harness.dispatch(dispatchOf("delete-file", "tc-3", { path: "/tmp/risky" }));
    const correlationId = await idP;
    await elicitation.respond({
      correlationId,
      outcome: "accepted",
      value: { approved: true, modifiedArguments: { path: "/tmp/safe" } },
    });

    await dispatchP;
    expect(receivedInput).toEqual({ path: "/tmp/safe" });
  });

  it("always: subsequent dispatches of the same tool skip the gate", async () => {
    let handlerRan = 0;
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [
        {
          handlerRef: "h.delete-file",
          handler: async () => {
            handlerRan++;
            return [{ type: "text", text: "ok" }];
          },
        },
      ],
    });

    const idP = nextElicitationCorrelationId(bus);
    const first = harness.dispatch(dispatchOf("delete-file", "tc-4"));
    const correlationId = await idP;
    await elicitation.respond({
      correlationId,
      outcome: "accepted",
      value: { approved: true, always: true },
    });
    await first;
    expect(handlerRan).toBe(1);

    // No elicit response delivered for the second call — gate skipped.
    const second = await harness.dispatch(dispatchOf("delete-file", "tc-5"));
    expect(second.isError ?? false).toBe(false);
    expect(handlerRan).toBe(2);
  });

  it("abort during wait: dispatch resolves as denial-shaped result", async () => {
    const { harness } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [
        {
          handlerRef: "h.delete-file",
          handler: async () => [{ type: "text", text: "never" }],
        },
      ],
    });

    const dispatchP = harness.dispatch(dispatchOf("delete-file", "tc-6"));
    setTimeout(() => {
      void harness.abort({ toolCallId: "tc-6", reason: "session closed" });
    }, 10);

    const result = await dispatchP;
    expect(result.isError).toBe(true);
    // Failure reason comes from the abort signal's reason — a tagged
    // ToolAbortedError stringified via the elicitation harness's
    // reason coercion.
    expect((result.content[0] as { text: string }).text).toContain("denied");
  });

  it("timeout: per-dispatch confirmationTimeoutMs trips ToolConfirmationTimeoutError", async () => {
    const { harness } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [
        {
          handlerRef: "h.delete-file",
          handler: async () => [{ type: "text", text: "never" }],
        },
      ],
    });

    await expect(
      harness.dispatch(dispatchOf("delete-file", "tc-7", {}, { confirmationTimeoutMs: 50 })),
    ).rejects.toBeInstanceOf(ToolConfirmationTimeoutError);
  });

  it("wire envelope: published with hints.kind=tool_confirmation and metadata fields", async () => {
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [
        {
          handlerRef: "h.delete-file",
          handler: async () => [{ type: "text", text: "ok" }],
        },
      ],
    });

    // Capture the full envelope for shape assertions.
    const envP = Effect.runPromise(
      Stream.runCollect(
        Stream.take(
          bus.subscribe({
            surface: "session",
            name: { exact: "session:channel:elicitation" },
          }) as Stream.Stream<EnvelopeWithMetadata, unknown, never>,
          1,
        ),
      ),
    ).then((chunk) => Array.from(Chunk.toReadonlyArray(chunk))[0]!);

    const dispatchP = harness.dispatch(dispatchOf("delete-file", "tc-wire", { path: "/x" }));
    const env = await envP;
    const payload = env.payload as {
      mode: string;
      message: string;
      hints?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    };
    expect(payload.mode).toBe("form");
    expect(payload.message).toContain("delete-file");
    expect(payload.hints?.kind).toBe("tool_confirmation");
    expect(payload.metadata).toMatchObject({
      toolUseId: "tc-wire",
      toolName: "delete-file",
      arguments: { path: "/x" },
    });

    // Clean up the pending dispatch.
    await elicitation.respond({
      correlationId: env.metadata!.correlationId as string,
      outcome: "declined",
    });
    await dispatchP;
  });
});
