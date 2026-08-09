/**
 * Standing confirmation grants — the two halves that make `always: true`
 * mean something beyond the current process.
 *
 *   - `onConfirmationResolved` — every ask reports how it settled
 *     (approved / denied / timeout / aborted), which is where an adopter
 *     writes the grant its `confirmationPolicy` will later read. An observer
 *     that throws is an observer that fails alone — loudly, at `warning`.
 *   - `exportSnapshot` / `importSnapshot` — the in-session grant set is
 *     session state, so it round-trips through a session snapshot.
 *
 * And the two ways a grant can be wrong: keyed by the alias a caller
 * dispatched by rather than the declaration's own name, or issued for a
 * dispatch that never ran because the host's edit failed validation.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Chunk, Effect, Stream } from "effect";
import type { LocalEventBus } from "@agentick/runtime";

import type {
  DispatchInput,
  ProtocolEvent,
  ToolConfirmationResolution,
  ToolRegistration,
} from "@agentick/spec";
import {
  logEventName,
  ToolConfirmationTimeoutError,
  ToolValidationError,
  jsonSchema,
} from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { fromStandardSchema } from "../validator.js";
import { createTestHarness } from "../testing/index.js";

function confirmTool(name = "delete-file", aliases?: readonly string[]): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: "risky",
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["model"],
      annotations: { requiresConfirmation: true },
      ...(aliases ? { aliases } : {}),
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

function nextElicitation(bus: LocalEventBus): Promise<EnvelopeWithMetadata> {
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
  ).then((chunk) => Array.from(Chunk.toReadonlyArray(chunk))[0]!);
}

function correlationIdOf(env: EnvelopeWithMetadata): string {
  const id = env.metadata?.correlationId;
  if (typeof id !== "string") throw new Error("expected correlationId");
  return id;
}

function nextElicitationCorrelationId(bus: LocalEventBus): Promise<string> {
  return nextElicitation(bus).then(correlationIdOf);
}

const OBSERVER_FAILURE = "grant store is down";

/**
 * Run `body` with a `process` rejection listener installed, then give the
 * event loop one turn so a rejection that escaped a fork has somewhere to
 * land. Only the observer's own failure counts — the listener is
 * process-wide, and another file's async noise is not this test's claim.
 */
async function observerFailuresEscapingDuring(body: () => Promise<void>): Promise<unknown[]> {
  const escaped: unknown[] = [];
  const listener = (reason: unknown): void => {
    if (String(reason).includes(OBSERVER_FAILURE)) escaped.push(reason);
  };
  process.on("unhandledRejection", listener);
  try {
    await body();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off("unhandledRejection", listener);
  }
  return escaped;
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

  it("a throwing observer runs, is logged at warning, and does not fail the dispatch", async () => {
    const ran = { count: 0 };
    const calls: ToolConfirmationResolution[] = [];
    const logs: ProtocolEvent[] = [];

    const escaped = await observerFailuresEscapingDuring(async () => {
      const { harness, bus, elicitation } = await createTestHarness({
        tools: [confirmTool()],
        handlers: [okHandler(ran)],
        onConfirmationResolved: (r) => {
          calls.push(r);
          throw new Error(OBSERVER_FAILURE);
        },
      });
      void Effect.runPromise(
        Stream.runForEach(
          Stream.take(bus.subscribe({ surface: "tool", name: { exact: logEventName("tool") } }), 1),
          (e) => Effect.sync(() => void logs.push(e)),
        ),
      );

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
      await waitFor(() => calls.length === 1, { description: "observer invoked" });
      await waitFor(() => logs.length === 1, { description: "observer failure logged" });
    });

    expect(calls[0]).toMatchObject({ toolUseId: "tc-7", outcome: "approved" });
    expect(logs[0]!.payload).toMatchObject({
      level: "warning",
      data: { message: "onConfirmationResolved observer failed", toolUseId: "tc-7" },
    });
    expect(escaped).toEqual([]);
  });

  it("a rejecting async observer runs, and its rejection never escapes the fork", async () => {
    const ran = { count: 0 };
    const calls: ToolConfirmationResolution[] = [];

    const escaped = await observerFailuresEscapingDuring(async () => {
      const { harness, bus, elicitation } = await createTestHarness({
        tools: [confirmTool()],
        handlers: [okHandler(ran)],
        onConfirmationResolved: async (r) => {
          calls.push(r);
          await Promise.reject(new Error(OBSERVER_FAILURE));
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
      await waitFor(() => calls.length === 1, { description: "observer invoked" });
    });

    expect(calls[0]).toMatchObject({ toolUseId: "tc-8", outcome: "approved" });
    expect(escaped).toEqual([]);
  });

  it("an ask torn down by the caller's abort reports aborted, not denied", async () => {
    const ran = { count: 0 };
    const seen: ToolConfirmationResolution[] = [];
    const { harness, bus } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [okHandler(ran)],
      onConfirmationResolved: (r) => {
        seen.push(r);
      },
    });

    const controller = new AbortController();
    const envP = nextElicitation(bus);
    const dispatchP = harness.dispatch(dispatchOf("tc-abort", {}, { signal: controller.signal }));
    await envP;
    controller.abort("caller went away");
    const result = await dispatchP;

    expect(result.isError).toBe(true);
    expect(ran.count).toBe(0);
    await waitFor(() => seen.length === 1, { description: "resolution reported" });
    expect(seen[0]!.outcome).toBe("aborted");
  });
});

describe("ToolExecutorHarness — a grant is keyed by the canonical tool name", () => {
  it("an alias dispatch grants the declaration's own name", async () => {
    const ran = { count: 0 };
    const seen: ToolConfirmationResolution[] = [];
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [confirmTool("delete-file", ["rm"])],
      handlers: [okHandler(ran)],
      onConfirmationResolved: (r) => {
        seen.push(r);
      },
    });

    const envP = nextElicitation(bus);
    const first = harness.dispatch(dispatchOf("tc-alias-1", {}, { name: "rm" }));
    const env = await envP;
    const askMetadata = (env.payload as { readonly metadata?: Record<string, unknown> }).metadata;
    expect(askMetadata?.["toolName"]).toBe("delete-file");

    await elicitation.respond({
      correlationId: correlationIdOf(env),
      outcome: "accepted",
      value: { approved: true, always: true },
    });
    await first;

    expect(seen).toHaveLength(1);
    expect(seen[0]!.toolName).toBe("delete-file");
    expect(harness.exportSnapshot()).toEqual({ alwaysAllowed: ["delete-file"] });

    // The canonical name is the same tool: the grant already covers it.
    await harness.dispatch(dispatchOf("tc-alias-2"));
    expect(ran.count).toBe(2);
    expect(seen).toHaveLength(1);
  });
});

describe("ToolExecutorHarness — an approval that never ran leaves nothing behind", () => {
  it("modifiedArguments that fail validation write no grant and no approval record", async () => {
    const ran = { count: 0 };
    const seen: ToolConfirmationResolution[] = [];
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [
        {
          ...okHandler(ran),
          validator: fromStandardSchema(z.object({ path: z.string() })),
        },
      ],
      onConfirmationResolved: (r) => {
        seen.push(r);
      },
    });

    const envP = nextElicitation(bus);
    const dispatchP = harness.dispatch(dispatchOf("tc-bad-edit", { path: "/tmp/ok" }));
    await elicitation.respond({
      correlationId: correlationIdOf(await envP),
      outcome: "accepted",
      value: { approved: true, always: true, modifiedArguments: { path: 42 } },
    });

    await expect(dispatchP).rejects.toBeInstanceOf(ToolValidationError);
    expect(ran.count).toBe(0);
    expect(harness.exportSnapshot()).toEqual({ alwaysAllowed: [] });
    expect(seen).toHaveLength(0);

    // No grant was issued, so the gate asks again.
    const envP2 = nextElicitation(bus);
    const second = harness.dispatch(dispatchOf("tc-bad-edit-2", { path: "/tmp/ok" }));
    await elicitation.respond({
      correlationId: correlationIdOf(await envP2),
      outcome: "declined",
      reason: "changed my mind",
    });
    await second;

    await waitFor(() => seen.length === 1, { description: "second ask reported" });
    expect(seen[0]!.outcome).toBe("denied");
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
