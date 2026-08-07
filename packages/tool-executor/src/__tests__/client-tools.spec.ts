/**
 * Client-handled tools + async confirmation predicate (Stage 1).
 *
 * Two capabilities baked into `dispatchBody`, both stubbed in-process
 * via the inbox exactly like the confirmation/elicitation tests:
 *
 *   A. Async `requiresConfirmation` predicate — the gate evaluates a
 *      `(input, ctx) => boolean | Promise<boolean>` against the
 *      validated input + live ctx. `true`/resolved-true elicits; falsy
 *      skips.
 *
 *   B. Handler-less = CLIENT-HANDLED tool (no `handlerRef`):
 *        - `requiresResponse: true`  → dispatch SUSPENDS via
 *          `this.request(TOOL_CALL_CHANNEL, …)` and resumes when a
 *          stubbed `request-response` inbox message relays the client's
 *          `ContentBlock[]`. Timeout → `defaultResult` when set, else
 *          `ToolCallTimeoutError`.
 *        - `requiresResponse` falsy → resolves immediately with
 *          `defaultResult` (or a canned success) and emits a
 *          fire-and-forget notification on the tool-call channel.
 *
 * Discriminator regression guard: a PRESENT-but-unresolvable
 * `handlerRef` still fails `ToolHandlerMissing`.
 */

import { describe, expect, it } from "vitest";
import { Chunk, Effect, Stream } from "effect";
import type { LocalEventBus, LocalInbox } from "@agentick/runtime";

import type {
  DispatchInput,
  ProtocolEvent,
  ToolAnnotations,
  ToolConfirmationPredicate,
  ToolRegistration,
} from "@agentick/spec";
import type { ClientToolDeclaration } from "@agentick/spec";
import {
  ToolCallTimeoutError,
  ToolHandlerMissing,
  jsonSchema,
  toClientToolRegistration,
} from "@agentick/spec";

import { createTestHarness } from "../testing/index.js";

type EnvelopeWithMetadata = ProtocolEvent & {
  readonly metadata?: Readonly<Record<string, unknown>>;
};

/** A CLIENT-HANDLED tool — no `handlerRef`. */
function clientTool(name: string, annotations: ToolAnnotations = {}): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: "client-handled",
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["model"],
      annotations,
    },
    binding: { scope: "runtime" },
  };
}

/** A server-handled tool whose confirmation is gated by a predicate. */
function guardedTool(name: string, predicate: ToolConfirmationPredicate): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: "guarded",
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["model"],
      annotations: { requiresConfirmation: predicate },
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
  return { toolCallId, name, input, context: { via: "model" }, ...overrides };
}

/** Next envelope on a fully-qualified channel; subscription hot on return. */
function nextEnvelope(bus: LocalEventBus, exact: string): Promise<EnvelopeWithMetadata> {
  return Effect.runPromise(
    Stream.runCollect(
      Stream.take(
        bus.subscribe({
          surface: "session",
          name: { exact },
        }) as Stream.Stream<EnvelopeWithMetadata, unknown, never>,
        1,
      ),
    ),
  ).then((chunk) => Array.from(Chunk.toReadonlyArray(chunk))[0]!);
}

/** Deliver the client's relayed result back through the harness inbox. */
async function relayToolResult(
  inbox: LocalInbox,
  address: string,
  correlationId: string,
  response: unknown,
): Promise<void> {
  await Effect.runPromise(
    inbox.send(address, {
      type: "request-response",
      correlationId,
      payload: { correlationId, response },
    }),
  );
}

describe("ToolExecutorHarness — async requiresConfirmation predicate", () => {
  it("predicate returns true → gate elicits, then handler runs on approval", async () => {
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [guardedTool("guard_true", () => true)],
      handlers: [
        { handlerRef: "h.guard_true", handler: async () => [{ type: "text", text: "ran" }] },
      ],
    });

    const idP = nextEnvelope(bus, "session:channel:elicitation");
    const dispatchP = harness.dispatch(dispatchOf("guard_true", "tc-p1"));
    const correlationId = (await idP).metadata!.correlationId as string;
    await elicitation.respond({ correlationId, outcome: "accepted", value: { approved: true } });

    const result = await dispatchP;
    expect((result.content[0] as { text: string }).text).toBe("ran");
  });

  it("predicate returns false → gate skipped, handler runs directly", async () => {
    let ran = 0;
    const { harness } = await createTestHarness({
      tools: [guardedTool("guard_false", () => false)],
      handlers: [
        {
          handlerRef: "h.guard_false",
          handler: async () => {
            ran++;
            return [{ type: "text", text: "ran" }];
          },
        },
      ],
    });

    const result = await harness.dispatch(dispatchOf("guard_false", "tc-p2"));
    expect(ran).toBe(1);
    expect(result.isError ?? false).toBe(false);
  });

  it("async Promise predicate is awaited and receives validated input + ctx", async () => {
    let seenInput: unknown;
    let seenCtxId: string | undefined;
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [
        guardedTool("guard_async", async (input, ctx) => {
          seenInput = input;
          seenCtxId = ctx.toolCallId;
          return true;
        }),
      ],
      handlers: [
        { handlerRef: "h.guard_async", handler: async () => [{ type: "text", text: "ran" }] },
      ],
    });

    const idP = nextEnvelope(bus, "session:channel:elicitation");
    const dispatchP = harness.dispatch(dispatchOf("guard_async", "tc-p3", { a: 1 }));
    const correlationId = (await idP).metadata!.correlationId as string;
    await elicitation.respond({ correlationId, outcome: "accepted", value: { approved: true } });

    await dispatchP;
    expect(seenInput).toEqual({ a: 1 });
    expect(seenCtxId).toBe("tc-p3");
  });
});

describe("ToolExecutorHarness — client-handled tools (requiresResponse:true)", () => {
  it("SUSPENDS until the client relays a result, then resolves with it (executedBy client)", async () => {
    const { harness, bus, inbox } = await createTestHarness({
      tools: [clientTool("client_echo", { requiresResponse: true })],
    });

    const reqP = nextEnvelope(bus, "session:channel:tool_call");
    const dispatchP = harness.dispatch(dispatchOf("client_echo", "tc-1", { q: "hi" }));

    const reqEnv = await reqP;
    // The outbound request carries the validated input + correlation.
    expect(reqEnv.metadata?.requestType).toBe("request");
    expect((reqEnv.payload as { name: string }).name).toBe("client_echo");
    expect((reqEnv.payload as { input: unknown }).input).toEqual({ q: "hi" });

    await relayToolResult(inbox, harness.address, reqEnv.metadata!.correlationId as string, [
      { type: "text", text: "from client" },
    ]);

    const result = await dispatchP;
    expect(result.executedBy).toBe("client");
    expect((result.content[0] as { text: string }).text).toBe("from client");
  });

  it("normalizes a bare string relay through normalizeToolResult", async () => {
    const { harness, bus, inbox } = await createTestHarness({
      tools: [clientTool("client_str", { requiresResponse: true })],
    });

    const reqP = nextEnvelope(bus, "session:channel:tool_call");
    const dispatchP = harness.dispatch(dispatchOf("client_str", "tc-1b"));
    const reqEnv = await reqP;
    await relayToolResult(inbox, harness.address, reqEnv.metadata!.correlationId as string, "hi");

    const result = await dispatchP;
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("timeout WITH defaultResult falls back to it", async () => {
    const { harness } = await createTestHarness({
      tools: [
        clientTool("client_slow", {
          requiresResponse: true,
          responseTimeoutMs: 30,
          defaultResult: [{ type: "text", text: "defaulted" }],
        }),
      ],
    });

    const result = await harness.dispatch(dispatchOf("client_slow", "tc-2"));
    expect((result.content[0] as { text: string }).text).toBe("defaulted");
    expect(result.executedBy).toBe("client");
  });

  it("timeout WITHOUT defaultResult fails ToolCallTimeoutError", async () => {
    const { harness } = await createTestHarness({
      tools: [clientTool("client_slow2", { requiresResponse: true, responseTimeoutMs: 30 })],
    });

    await expect(harness.dispatch(dispatchOf("client_slow2", "tc-3"))).rejects.toBeInstanceOf(
      ToolCallTimeoutError,
    );
  });

  it("per-dispatch responseTimeoutMs applies when annotations omit it", async () => {
    const { harness } = await createTestHarness({
      tools: [clientTool("client_slow3", { requiresResponse: true })],
    });

    await expect(
      harness.dispatch(dispatchOf("client_slow3", "tc-3b", {}, { responseTimeoutMs: 30 })),
    ).rejects.toBeInstanceOf(ToolCallTimeoutError);
  });
});

describe("ToolExecutorHarness — client-handled tools (fire-and-forget)", () => {
  it("resolves immediately with defaultResult and emits a notify on the tool-call channel", async () => {
    const { harness, bus } = await createTestHarness({
      tools: [clientTool("client_fire", { defaultResult: [{ type: "text", text: "ack" }] })],
    });

    const notifyP = nextEnvelope(bus, "session:channel:tool_call");
    const result = await harness.dispatch(dispatchOf("client_fire", "tc-4", { x: 1 }));

    expect((result.content[0] as { text: string }).text).toBe("ack");
    expect(result.executedBy).toBe("client");

    const env = await notifyP;
    // Fire-and-forget: a one-way notify, NOT a correlated request.
    expect(env.metadata?.requestType).toBe("notify");
    expect(env.metadata?.correlationId).toBeUndefined();
    expect((env.payload as { name: string }).name).toBe("client_fire");
    expect((env.payload as { input: unknown }).input).toEqual({ x: 1 });
  });

  it("falls back to a canned success block when no defaultResult is set", async () => {
    const { harness } = await createTestHarness({
      tools: [clientTool("client_fire2")],
    });

    const result = await harness.dispatch(dispatchOf("client_fire2", "tc-5"));
    expect(result.content).toEqual([{ type: "text", text: "executed successfully" }]);
    expect(result.executedBy).toBe("client");
  });
});

describe("ToolExecutorHarness — respondToToolCall (stage 2 wire seam)", () => {
  it("resolves a suspended client dispatch with the relayed result (reuses the inbox auto-intercept)", async () => {
    const { harness, bus } = await createTestHarness({
      tools: [clientTool("client_respond", { requiresResponse: true })],
    });

    const reqP = nextEnvelope(bus, "session:channel:tool_call");
    const dispatchP = harness.dispatch(dispatchOf("client_respond", "tc-r1", { q: "hi" }));
    const reqEnv = await reqP;
    const correlationId = reqEnv.metadata!.correlationId as string;

    // The NEW method — the same path the gateway wire handler calls. NOT the
    // raw inbox relay: this proves respondToToolCall lands the result through
    // BaseHarness.dispatchMessage's request-response auto-intercept.
    await harness.respondToToolCall({
      correlationId,
      result: [{ type: "text", text: "relayed via respondToToolCall" }],
    });

    const result = await dispatchP;
    expect(result.executedBy).toBe("client");
    expect((result.content[0] as { text: string }).text).toBe("relayed via respondToToolCall");
  });

  it("SECURITY: a client-handled tool cannot spoof executedBy — the client path is hardcoded", async () => {
    // Second, architecture-level guard (the wire fold strip is the first): even
    // if a client-handled registration somehow carried `annotations.executedBy`,
    // the client-handled stamp site NEVER reads it — it is hardcoded "client".
    // A client-declared tool has no `handlerRef`, so it can never reach the
    // server-handled stamp site that consults `annotations.executedBy`.
    const { harness, bus } = await createTestHarness({
      tools: [
        clientTool("client_spoof", {
          requiresResponse: true,
          executedBy: "provider:anthropic",
        }),
      ],
    });

    const reqP = nextEnvelope(bus, "session:channel:tool_call");
    const dispatchP = harness.dispatch(dispatchOf("client_spoof", "tc-spoof", { q: "hi" }));
    const correlationId = (await reqP).metadata!.correlationId as string;
    await harness.respondToToolCall({
      correlationId,
      result: [{ type: "text", text: "ok" }],
    });

    const result = await dispatchP;
    // The smuggled provenance is IGNORED — stamped "client", not the spoof.
    expect(result.executedBy).toBe("client");
  });

  it("normalizes a bare string result relayed through respondToToolCall", async () => {
    const { harness, bus } = await createTestHarness({
      tools: [clientTool("client_respond_str", { requiresResponse: true })],
    });

    const reqP = nextEnvelope(bus, "session:channel:tool_call");
    const dispatchP = harness.dispatch(dispatchOf("client_respond_str", "tc-r2"));
    const correlationId = (await reqP).metadata!.correlationId as string;
    await harness.respondToToolCall({ correlationId, result: "plain" });

    const result = await dispatchP;
    expect(result.content).toEqual([{ type: "text", text: "plain" }]);
  });

  it("an unknown correlationId is a silent no-op (first-write-wins)", async () => {
    const { harness } = await createTestHarness({ tools: [] });
    await expect(
      harness.respondToToolCall({ correlationId: "never-issued", result: "x" }),
    ).resolves.toBeUndefined();
  });

  it("a client tool registered via toClientToolRegistration dispatches through the client path", async () => {
    const { harness, bus } = await createTestHarness({ tools: [] });

    const declaration: ClientToolDeclaration = {
      name: "wire_registered",
      description: "registered over the wire slice",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      annotations: { requiresResponse: true },
    };
    // Exactly what the `session/set_client_tools` gateway handler does per
    // declaration — fold into a client-handled registration at the `client` slice.
    await harness.register({
      registration: toClientToolRegistration(declaration, {
        scope: "client",
        sessionId: "sess-1",
      }),
    });

    // It enters the model-visible tool list.
    const compiled = await harness.compileForTick({ exposure: "model" });
    expect(compiled.map((d) => d.name)).toContain("wire_registered");

    // And a model call relays to the client + resumes via respondToToolCall.
    const reqP = nextEnvelope(bus, "session:channel:tool_call");
    const dispatchP = harness.dispatch(dispatchOf("wire_registered", "tc-r3", { q: "yo" }));
    const reqEnv = await reqP;
    expect((reqEnv.payload as { name: string }).name).toBe("wire_registered");
    await harness.respondToToolCall({
      correlationId: reqEnv.metadata!.correlationId as string,
      result: [{ type: "text", text: "ok" }],
    });

    const result = await dispatchP;
    expect(result.executedBy).toBe("client");
    expect((result.content[0] as { text: string }).text).toBe("ok");
  });
});

describe("ToolExecutorHarness — discriminator regression guard", () => {
  it("handlerRef PRESENT but unresolvable still fails ToolHandlerMissing", async () => {
    const { harness } = await createTestHarness({
      tools: [
        {
          declaration: {
            id: "orphan",
            name: "orphan",
            description: "ref points nowhere",
            inputSchema: jsonSchema({ type: "object" }),
            exposure: ["model"],
          },
          handlerRef: "h.nonexistent",
          binding: { scope: "runtime" },
        },
      ],
      // No handler registered for `h.nonexistent` → resolver returns undefined.
    });

    await expect(harness.dispatch(dispatchOf("orphan", "tc-miss"))).rejects.toBeInstanceOf(
      ToolHandlerMissing,
    );
  });

  it("client tool gates on confirmation BEFORE relaying (deny → no relay, denial result)", async () => {
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [
        clientTool("client_confirmed", { requiresResponse: true, requiresConfirmation: true }),
      ],
    });

    const idP = nextEnvelope(bus, "session:channel:elicitation");
    const dispatchP = harness.dispatch(dispatchOf("client_confirmed", "tc-cc"));
    const correlationId = (await idP).metadata!.correlationId as string;
    await elicitation.respond({ correlationId, outcome: "declined", reason: "nope" });

    const result = await dispatchP;
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("denied");
  });
});

describe("client targeting — the relay addresses the client that asked", () => {
  it("stamps the execution's client as `target` on a correlated relay", async () => {
    const { harness, bus } = await createTestHarness({
      tools: [clientTool("client_nav", { requiresResponse: true })],
    });

    const reqP = nextEnvelope(bus, "session:channel:tool_call");
    void harness.dispatch(
      dispatchOf(
        "client_nav",
        "tc-target",
        { to: "/reports" },
        {
          context: { via: "model", clientId: "client-TAB-A" },
        },
      ),
    );

    const env = await reqP;
    expect((env.payload as { target?: string }).target).toBe("client-TAB-A");
  });

  it("stamps it on a fire-and-forget notify too — a toast is still addressed", async () => {
    const { harness, bus } = await createTestHarness({
      tools: [clientTool("client_toast", { defaultResult: [{ type: "text", text: "ack" }] })],
    });

    const notifyP = nextEnvelope(bus, "session:channel:tool_call");
    await harness.dispatch(
      dispatchOf(
        "client_toast",
        "tc-fire",
        { x: 1 },
        {
          context: { via: "model", clientId: "client-TAB-B" },
        },
      ),
    );

    expect((await notifyP).payload).toMatchObject({ target: "client-TAB-B" });
  });

  it("omits `target` when the execution had no client — a cron run addresses nobody", async () => {
    const { harness, bus } = await createTestHarness({
      tools: [clientTool("client_nav2", { requiresResponse: true })],
    });

    const reqP = nextEnvelope(bus, "session:channel:tool_call");
    void harness.dispatch(dispatchOf("client_nav2", "tc-none", { to: "/x" }));

    const payload = (await reqP).payload as Record<string, unknown>;
    // Absent, not null/"" — every client reads that as "not for anyone in
    // particular" and the default `accepts` rule lets them all take it.
    expect("target" in payload).toBe(false);
  });
});
