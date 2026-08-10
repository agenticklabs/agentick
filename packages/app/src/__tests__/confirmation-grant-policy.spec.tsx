/**
 * "Always allow this tool" is an APPLICATION feature, built from two pieces
 * the framework does ship: the decision it publishes on
 * `DispatchResult.confirmation`, and the `confirmationPolicy` seam it consults
 * before asking. Nothing in the framework remembers the grant — this file is
 * the whole pattern, written the way an adopter writes it.
 */

import React from "react";
import { describe, expect, it } from "vitest";
import { Chunk, Effect, Stream } from "effect";

import { createApp } from "../react.js";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { ContentBlock, ProtocolEvent, ToolDeclaration } from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";

const Agent = (): React.ReactElement => React.createElement("message", { role: "user" }, "hello");

const deleteFile: ToolDeclaration = {
  id: "t.delete-file",
  name: "delete-file",
  description: "risky",
  inputSchema: jsonSchema({ type: "object" }),
  exposure: ["model", "dispatch"],
  handlerRef: "h.delete-file",
  annotations: { requiresConfirmation: true },
};

async function mkExecutor(id: string) {
  const exec = new FakeLanguageModelExecutor(
    id,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "ok" } satisfies ContentBlock],
            stopReason: "end",
          },
        },
      ],
    },
  );
  await exec.ready;
  return exec;
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
    const id = Array.from(Chunk.toReadonlyArray(chunk))[0]!.metadata?.correlationId;
    if (typeof id !== "string") throw new Error("expected correlationId");
    return id;
  });
}

describe("AppHarness — an adopter's standing grants", () => {
  it("the hook records what the policy reads back: asked once, never again", async () => {
    const ran: string[] = [];
    const granted = new Set<string>();
    const bus = new LocalEventBus();

    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor("grant-policy-exec"),
      bus,
      tools: [deleteFile],
      toolHandlers: new Map([
        [
          "h.delete-file",
          async () => {
            ran.push("delete-file");
            return [{ type: "text" as const, text: "gone" }];
          },
        ],
      ]),
      hooks: {
        onAfterToolDispatch: (result) => {
          const decision = result.confirmation;
          if (decision?.outcome === "approved" && decision.always === true) {
            granted.add(`${decision.sessionId}:${decision.toolName}`);
          }
          return result;
        },
      },
      toolExecutor: {
        confirmationPolicy: ({ declaration, ctx, toolVerdict }) =>
          granted.has(`${ctx.sessionId}:${declaration.name}`) ? false : toolVerdict,
        // A re-ask must fail fast rather than hang out the test timeout.
        defaultConfirmationTimeoutMs: 1_000,
      },
    });

    const session = await app.createSession();

    const idP = nextElicitationCorrelationId(bus);
    const dispatchP = session.tools.dispatch("delete-file", { path: "/tmp/x" });
    await session.elicitation.respond({
      correlationId: await idP,
      outcome: "accepted",
      value: { approved: true, always: true },
    });
    await dispatchP;

    expect(granted.has(`${session.id}:delete-file`)).toBe(true);

    // Nobody answers an elicitation for this one — the policy suppresses the ask.
    await session.tools.dispatch("delete-file", { path: "/tmp/x" });
    expect(ran).toEqual(["delete-file", "delete-file"]);

    // The grant this app scoped to a session does not leak to the next one.
    const other = await app.createSession();
    const otherIdP = nextElicitationCorrelationId(bus);
    const otherDispatchP = other.tools.dispatch("delete-file", { path: "/tmp/x" });
    await other.elicitation.respond({
      correlationId: await otherIdP,
      outcome: "accepted",
      value: { approved: true },
    });
    await otherDispatchP;

    expect(ran).toHaveLength(3);

    await app.closeApp();
  });

  it("without that policy nothing is remembered — the second call is asked about again", async () => {
    const ran: string[] = [];
    const bus = new LocalEventBus();

    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor("no-grant-exec"),
      bus,
      tools: [deleteFile],
      toolHandlers: new Map([
        [
          "h.delete-file",
          async () => {
            ran.push("delete-file");
            return [{ type: "text" as const, text: "gone" }];
          },
        ],
      ]),
      toolExecutor: { defaultConfirmationTimeoutMs: 250 },
    });

    const session = await app.createSession();

    const idP = nextElicitationCorrelationId(bus);
    const dispatchP = session.tools.dispatch("delete-file", { path: "/tmp/x" });
    await session.elicitation.respond({
      correlationId: await idP,
      outcome: "accepted",
      value: { approved: true, always: true },
    });
    await dispatchP;

    await expect(session.tools.dispatch("delete-file", { path: "/tmp/x" })).rejects.toMatchObject({
      _tag: "ToolConfirmationTimeoutError",
    });
    expect(ran).toEqual(["delete-file"]);

    await app.closeApp();
  });
});
