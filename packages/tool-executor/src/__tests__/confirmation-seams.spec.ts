/**
 * Restored v1 confirmation affordances (Pass A) — evaluated INTO the
 * existing elicit `message` / `metadata` slots + the client-tool
 * `defaultResult` sites, plus dispatch-by-alias resolution.
 *
 *   - `confirmationMessage` (string | (input, ctx) => string) → the
 *     elicitation request's `message`. Absent → the default prompt.
 *   - `confirmationPreview` (async) → merged under `metadata.preview`,
 *     leaving the existing `toolUseId` / `toolName` / `arguments` intact.
 *   - `defaultResult` widened to a callable — evaluated for BOTH the
 *     fire-and-forget resolve and the `requiresResponse` timeout fallback.
 *   - `aliases` → `session.tools.dispatch(alias, …)` resolves the tool.
 */

import { describe, expect, it } from "vitest";
import { Chunk, Effect, Stream } from "effect";
import type { LocalEventBus } from "@agentick/runtime";

import type { DispatchInput, ProtocolEvent, ToolRegistration } from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";

import { createTestHarness } from "../testing/index.js";

type EnvelopeWithMetadata = ProtocolEvent & {
  readonly metadata?: Readonly<Record<string, unknown>>;
};

type ConfirmationPayload = {
  readonly mode: string;
  readonly message: string;
  readonly hints?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
};

function confirmReg(
  name: string,
  decl: Partial<ToolRegistration["declaration"]>,
): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: "risky",
      inputSchema: jsonSchema({ type: "object" }),
      exposure: ["model"],
      annotations: { requiresConfirmation: true },
      ...decl,
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

/** Capture the next elicitation request envelope (subscription hot on return). */
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

describe("ToolExecutorHarness — confirmationMessage seam", () => {
  it("static string becomes the elicit message", async () => {
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [
        confirmReg("del", {
          annotations: { requiresConfirmation: true, confirmationMessage: "Really delete it?" },
        }),
      ],
      handlers: [{ handlerRef: "h.del", handler: async () => [{ type: "text", text: "ok" }] }],
    });

    const envP = nextElicitation(bus);
    const dispatchP = harness.dispatch(dispatchOf("del", "tc-1"));
    const env = await envP;
    expect((env.payload as ConfirmationPayload).message).toBe("Really delete it?");

    await elicitation.respond({
      correlationId: env.metadata!.correlationId as string,
      outcome: "declined",
    });
    await dispatchP;
  });

  it("function form receives validated input + ctx and produces the message", async () => {
    let seenInput: unknown;
    let seenCtxId: string | undefined;
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [
        confirmReg("pay", {
          annotations: {
            requiresConfirmation: true,
            confirmationMessage: (input, ctx) => {
              seenInput = input;
              seenCtxId = ctx.toolCallId;
              return `Send $${(input as { amount: number }).amount}?`;
            },
          },
        }),
      ],
      handlers: [{ handlerRef: "h.pay", handler: async () => [{ type: "text", text: "ok" }] }],
    });

    const envP = nextElicitation(bus);
    const dispatchP = harness.dispatch(dispatchOf("pay", "tc-2", { amount: 42 }));
    const env = await envP;
    expect((env.payload as ConfirmationPayload).message).toBe("Send $42?");
    expect(seenInput).toEqual({ amount: 42 });
    expect(seenCtxId).toBe("tc-2");

    await elicitation.respond({
      correlationId: env.metadata!.correlationId as string,
      outcome: "declined",
    });
    await dispatchP;
  });

  it("async function form is awaited", async () => {
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [
        confirmReg("async-msg", {
          annotations: {
            requiresConfirmation: true,
            confirmationMessage: async () => "computed prompt",
          },
        }),
      ],
      handlers: [
        { handlerRef: "h.async-msg", handler: async () => [{ type: "text", text: "ok" }] },
      ],
    });

    const envP = nextElicitation(bus);
    const dispatchP = harness.dispatch(dispatchOf("async-msg", "tc-3"));
    const env = await envP;
    expect((env.payload as ConfirmationPayload).message).toBe("computed prompt");

    await elicitation.respond({
      correlationId: env.metadata!.correlationId as string,
      outcome: "declined",
    });
    await dispatchP;
  });

  it("regression: no confirmationMessage → the default prompt", async () => {
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [confirmReg("plain", {})],
      handlers: [{ handlerRef: "h.plain", handler: async () => [{ type: "text", text: "ok" }] }],
    });

    const envP = nextElicitation(bus);
    const dispatchP = harness.dispatch(dispatchOf("plain", "tc-4"));
    const env = await envP;
    expect((env.payload as ConfirmationPayload).message).toBe('Approve tool "plain"?');

    await elicitation.respond({
      correlationId: env.metadata!.correlationId as string,
      outcome: "declined",
    });
    await dispatchP;
  });
});

describe("ToolExecutorHarness — confirmationPreview seam", () => {
  it("preview keys are merged under metadata.preview; existing keys intact", async () => {
    let seenInput: unknown;
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [
        confirmReg("edit", {
          annotations: {
            requiresConfirmation: true,
            confirmationPreview: async (input) => {
              seenInput = input;
              return { diff: "-a\n+b", lines: 2 };
            },
          },
        }),
      ],
      handlers: [{ handlerRef: "h.edit", handler: async () => [{ type: "text", text: "ok" }] }],
    });

    const envP = nextElicitation(bus);
    const dispatchP = harness.dispatch(dispatchOf("edit", "tc-5", { path: "/f" }));
    const env = await envP;
    const meta = (env.payload as ConfirmationPayload).metadata!;

    // Existing metadata keys are untouched…
    expect(meta).toMatchObject({
      toolUseId: "tc-5",
      toolName: "edit",
      arguments: { path: "/f" },
    });
    // …and the preview lands under its own sub-key (no collisions).
    expect(meta.preview).toEqual({ diff: "-a\n+b", lines: 2 });
    expect(seenInput).toEqual({ path: "/f" });

    await elicitation.respond({
      correlationId: env.metadata!.correlationId as string,
      outcome: "declined",
    });
    await dispatchP;
  });

  it("no preview → metadata carries no `preview` key", async () => {
    const { harness, bus, elicitation } = await createTestHarness({
      tools: [confirmReg("nopreview", {})],
      handlers: [
        { handlerRef: "h.nopreview", handler: async () => [{ type: "text", text: "ok" }] },
      ],
    });

    const envP = nextElicitation(bus);
    const dispatchP = harness.dispatch(dispatchOf("nopreview", "tc-6"));
    const env = await envP;
    expect((env.payload as ConfirmationPayload).metadata).not.toHaveProperty("preview");

    await elicitation.respond({
      correlationId: env.metadata!.correlationId as string,
      outcome: "declined",
    });
    await dispatchP;
  });
});

describe("ToolExecutorHarness — defaultResult callable", () => {
  /** A CLIENT-HANDLED tool — no handlerRef. */
  function clientTool(
    name: string,
    annotations: ToolRegistration["declaration"]["annotations"],
  ): ToolRegistration {
    return {
      declaration: {
        id: name,
        name,
        description: "client",
        inputSchema: jsonSchema({ type: "object" }),
        exposure: ["model"],
        annotations,
      },
      binding: { scope: "runtime" },
    };
  }

  it("fire-and-forget: callable defaultResult is evaluated on the validated input", async () => {
    let seenInput: unknown;
    const { harness } = await createTestHarness({
      tools: [
        clientTool("fire_fn", {
          defaultResult: (input) => {
            seenInput = input;
            return [{ type: "text", text: `ack ${(input as { id: string }).id}` }];
          },
        }),
      ],
    });

    const result = await harness.dispatch(dispatchOf("fire_fn", "tc-7", { id: "abc" }));
    expect((result.content[0] as { text: string }).text).toBe("ack abc");
    expect(result.executedBy).toBe("client");
    expect(seenInput).toEqual({ id: "abc" });
  });

  it("requiresResponse timeout: callable defaultResult is the fallback", async () => {
    const { harness } = await createTestHarness({
      tools: [
        clientTool("slow_fn", {
          requiresResponse: true,
          responseTimeoutMs: 30,
          defaultResult: async (input) => [
            { type: "text", text: `fallback ${(input as { q: string }).q}` },
          ],
        }),
      ],
    });

    const result = await harness.dispatch(dispatchOf("slow_fn", "tc-8", { q: "z" }));
    expect((result.content[0] as { text: string }).text).toBe("fallback z");
    expect(result.executedBy).toBe("client");
  });
});

describe("ToolExecutorHarness — alias dispatch resolution", () => {
  it("dispatch by an alias resolves to the tool", async () => {
    let ran = 0;
    const { harness } = await createTestHarness({
      tools: [
        {
          declaration: {
            id: "list_directory",
            name: "list_directory",
            description: "aliased",
            inputSchema: jsonSchema({ type: "object" }),
            exposure: ["model", "dispatch"],
            aliases: ["ls", "dir"],
          },
          handlerRef: "h.ls",
          binding: { scope: "runtime" },
        },
      ],
      handlers: [
        {
          handlerRef: "h.ls",
          handler: async () => {
            ran++;
            return [{ type: "text", text: "listed" }];
          },
        },
      ],
    });

    const byAlias = await harness.dispatch(
      dispatchOf("ls", "tc-9", {}, { context: { via: "dispatch" } }),
    );
    expect((byAlias.content[0] as { text: string }).text).toBe("listed");

    const bySecondAlias = await harness.dispatch(
      dispatchOf("dir", "tc-10", {}, { context: { via: "dispatch" } }),
    );
    expect((bySecondAlias.content[0] as { text: string }).text).toBe("listed");

    // Canonical name still resolves.
    const byName = await harness.dispatch(
      dispatchOf("list_directory", "tc-11", {}, { context: { via: "dispatch" } }),
    );
    expect((byName.content[0] as { text: string }).text).toBe("listed");
    expect(ran).toBe(3);
  });
});
