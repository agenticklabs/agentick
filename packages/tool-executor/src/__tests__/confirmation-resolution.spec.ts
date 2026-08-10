/**
 * The confirmation gate publishes its decision and forgets it.
 *
 *   - Every arm that resolves stamps `DispatchResult.confirmation`; the one
 *     that rejects (timeout) carries the same record on its error. Nobody
 *     needs a bespoke seam to watch a decision.
 *   - `always: true` is RELAYED, never honored: the framework respects what a
 *     tool declares and reports what a host decided, and remembering the
 *     decision is the application's job.
 *   - A tool that declares no verdict of its own gets one derived from its
 *     advisory hints, which an explicit `requiresConfirmation` — and above
 *     that a `confirmationPolicy` — outranks.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Chunk, Effect, Stream } from "effect";
import type { LocalEventBus } from "@agentick/runtime";

import type {
  DispatchInput,
  ProtocolEvent,
  ToolAnnotations,
  ToolRegistration,
} from "@agentick/spec";
import { ToolConfirmationTimeoutError, ToolValidationError, jsonSchema } from "@agentick/spec";

import { fromStandardSchema } from "../validator.js";
import { createTestHarness } from "../testing/index.js";

function toolWith(
  annotations: ToolAnnotations,
  name = "delete-file",
  aliases?: readonly string[],
): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: "risky",
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["model"],
      annotations,
      ...(aliases ? { aliases } : {}),
    },
    handlerRef: `h.${name}`,
    binding: { scope: "runtime" },
  };
}

function confirmTool(name = "delete-file", aliases?: readonly string[]): ToolRegistration {
  return toolWith({ requiresConfirmation: true }, name, aliases);
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

describe("ToolExecutorHarness — the decision rides the dispatch result", () => {
  it("an approval stamps the record, canonically named, with the pre-edit arguments", async () => {
    const ran = { count: 0 };
    const { harness, bus, elicitation } = await createTestHarness({
      scopeId: "sess-decide",
      tools: [confirmTool()],
      handlers: [okHandler(ran)],
    });

    const idP = nextElicitationCorrelationId(bus);
    const dispatchP = harness.dispatch(dispatchOf("tc-1", { path: "/tmp/risky" }));
    await elicitation.respond({
      correlationId: await idP,
      outcome: "accepted",
      value: { approved: true, always: true, modifiedArguments: { path: "/tmp/safe" } },
    });
    const result = await dispatchP;

    expect(result.confirmation).toEqual({
      toolUseId: "tc-1",
      toolName: "delete-file",
      sessionId: "sess-decide",
      outcome: "approved",
      always: true,
      // `arguments` is what was ASKED about; the host's edit rides separately.
      arguments: { path: "/tmp/risky" },
      modifiedArguments: { path: "/tmp/safe" },
    });
    expect(ran.count).toBe(1);
  });

  it("a one-off approval relays no grant", async () => {
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [okHandler({ count: 0 })],
    });

    const idP = nextElicitationCorrelationId(bus);
    const dispatchP = harness.dispatch(dispatchOf("tc-2"));
    await elicitation.respond({
      correlationId: await idP,
      outcome: "accepted",
      value: { approved: true },
    });
    const result = await dispatchP;

    expect(result.confirmation?.outcome).toBe("approved");
    expect(result.confirmation?.always).toBeUndefined();
  });

  it("a denial stamps the record on the soft-error result it returns", async () => {
    const ran = { count: 0 };
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [okHandler(ran)],
    });

    const idP = nextElicitationCorrelationId(bus);
    const dispatchP = harness.dispatch(dispatchOf("tc-3"));
    await elicitation.respond({
      correlationId: await idP,
      outcome: "declined",
      reason: "not today",
    });
    const result = await dispatchP;

    expect(result.isError).toBe(true);
    expect(result.confirmation?.outcome).toBe("denied");
    expect(result.confirmation?.reason).toContain("not today");
    expect(ran.count).toBe(0);
  });

  it("an ask torn down by the caller's abort reports aborted, not denied", async () => {
    const ran = { count: 0 };
    const { harness, bus } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [okHandler(ran)],
    });

    const controller = new AbortController();
    const envP = nextElicitation(bus);
    const dispatchP = harness.dispatch(dispatchOf("tc-abort", {}, { signal: controller.signal }));
    await envP;
    controller.abort("caller went away");
    const result = await dispatchP;

    expect(result.isError).toBe(true);
    expect(result.confirmation?.outcome).toBe("aborted");
    expect(ran.count).toBe(0);
  });

  it("an expiry rejects, and the error carries the record the other arms publish", async () => {
    const { harness } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [okHandler({ count: 0 })],
      scopeId: "sess-expire",
    });

    const rejection = await harness
      .dispatch(dispatchOf("tc-4", { path: "/tmp/risky" }, { confirmationTimeoutMs: 25 }))
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(rejection).toBeInstanceOf(ToolConfirmationTimeoutError);
    expect((rejection as ToolConfirmationTimeoutError).confirmation).toEqual({
      toolUseId: "tc-4",
      toolName: "delete-file",
      sessionId: "sess-expire",
      outcome: "timeout",
      arguments: { path: "/tmp/risky" },
    });
  });

  it("a dispatch nobody was asked about carries no record", async () => {
    const ran = { count: 0 };
    const { harness } = await createTestHarness({
      tools: [toolWith({})],
      handlers: [okHandler(ran)],
    });

    const result = await harness.dispatch(dispatchOf("tc-5"));

    expect(result.confirmation).toBeUndefined();
    expect(ran.count).toBe(1);
  });

  it("an alias dispatch is asked about, and reported under, the declaration's own name", async () => {
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [confirmTool("delete-file", ["rm"])],
      handlers: [okHandler({ count: 0 })],
    });

    const envP = nextElicitation(bus);
    const dispatchP = harness.dispatch(dispatchOf("tc-alias", {}, { name: "rm" }));
    const env = await envP;
    const askMetadata = (env.payload as { readonly metadata?: Record<string, unknown> }).metadata;
    expect(askMetadata?.["toolName"]).toBe("delete-file");

    await elicitation.respond({
      correlationId: correlationIdOf(env),
      outcome: "accepted",
      value: { approved: true, always: true },
    });
    const result = await dispatchP;

    expect(result.confirmation?.toolName).toBe("delete-file");
  });

  it("`always` is relayed, not remembered — the next call is asked about again", async () => {
    const ran = { count: 0 };
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [okHandler(ran)],
    });

    const firstId = nextElicitationCorrelationId(bus);
    const first = harness.dispatch(dispatchOf("tc-always-1"));
    await elicitation.respond({
      correlationId: await firstId,
      outcome: "accepted",
      value: { approved: true, always: true },
    });
    expect((await first).confirmation?.always).toBe(true);

    const secondId = nextElicitationCorrelationId(bus);
    const second = harness.dispatch(dispatchOf("tc-always-2"));
    await elicitation.respond({
      correlationId: await secondId,
      outcome: "accepted",
      value: { approved: true },
    });
    const result = await second;

    expect(result.confirmation?.outcome).toBe("approved");
    expect(ran.count).toBe(2);
  });

  it("an edit that fails re-validation rejects, claiming no approval and running nothing", async () => {
    const ran = { count: 0 };
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [confirmTool()],
      handlers: [
        { ...okHandler(ran), validator: fromStandardSchema(z.object({ path: z.string() })) },
      ],
    });

    const envP = nextElicitation(bus);
    const dispatchP = harness.dispatch(dispatchOf("tc-bad-edit", { path: "/tmp/ok" }));
    await elicitation.respond({
      correlationId: correlationIdOf(await envP),
      outcome: "accepted",
      value: { approved: true, always: true, modifiedArguments: { path: 42 } },
    });

    const rejection = await dispatchP.then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(rejection).toBeInstanceOf(ToolValidationError);
    expect(rejection).not.toHaveProperty("confirmation");
    expect(ran.count).toBe(0);
  });
});

describe("ToolExecutorHarness — the verdict a tool did not declare", () => {
  it("a destructive tool is asked about", async () => {
    const ran = { count: 0 };
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [toolWith({ destructiveHint: true })],
      handlers: [okHandler(ran)],
    });

    const idP = nextElicitationCorrelationId(bus);
    const dispatchP = harness.dispatch(dispatchOf("tc-hint-1"));
    await elicitation.respond({
      correlationId: await idP,
      outcome: "accepted",
      value: { approved: true },
    });
    const result = await dispatchP;

    expect(result.confirmation?.outcome).toBe("approved");
    expect(ran.count).toBe(1);
  });

  it("a read-only tool never is", async () => {
    const ran = { count: 0 };
    const { harness } = await createTestHarness({
      tools: [toolWith({ readOnlyHint: true })],
      handlers: [okHandler(ran)],
    });

    // Nobody answers an elicitation here — a gate would hang this dispatch.
    const result = await harness.dispatch(dispatchOf("tc-hint-2"));

    expect(result.confirmation).toBeUndefined();
    expect(ran.count).toBe(1);
  });

  it("read-only wins over destructive — MCP scopes the destructive hint to writes", async () => {
    const ran = { count: 0 };
    const { harness } = await createTestHarness({
      tools: [toolWith({ readOnlyHint: true, destructiveHint: true })],
      handlers: [okHandler(ran)],
    });

    const result = await harness.dispatch(dispatchOf("tc-hint-2b"));

    expect(result.confirmation).toBeUndefined();
    expect(ran.count).toBe(1);
  });

  it("an unhinted tool never is", async () => {
    const ran = { count: 0 };
    const { harness } = await createTestHarness({
      tools: [toolWith({ idempotentHint: true })],
      handlers: [okHandler(ran)],
    });

    const result = await harness.dispatch(dispatchOf("tc-hint-3"));

    expect(result.confirmation).toBeUndefined();
    expect(ran.count).toBe(1);
  });

  it("the tool's own `requiresConfirmation: false` outranks a destructive hint", async () => {
    const ran = { count: 0 };
    const { harness } = await createTestHarness({
      tools: [toolWith({ destructiveHint: true, requiresConfirmation: false })],
      handlers: [okHandler(ran)],
    });

    const result = await harness.dispatch(dispatchOf("tc-hint-4"));

    expect(result.confirmation).toBeUndefined();
    expect(ran.count).toBe(1);
  });

  it("the policy outranks both — a read-only tool it forces an ask on is asked about", async () => {
    const ran = { count: 0 };
    const verdicts: boolean[] = [];
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [toolWith({ readOnlyHint: true })],
      handlers: [okHandler(ran)],
      confirmationPolicy: ({ toolVerdict }) => {
        verdicts.push(toolVerdict);
        return true;
      },
    });

    const idP = nextElicitationCorrelationId(bus);
    const dispatchP = harness.dispatch(dispatchOf("tc-hint-5"));
    await elicitation.respond({
      correlationId: await idP,
      outcome: "accepted",
      value: { approved: true },
    });
    const result = await dispatchP;

    expect(verdicts).toEqual([false]);
    expect(result.confirmation?.outcome).toBe("approved");
    expect(ran.count).toBe(1);
  });
});
