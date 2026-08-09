/**
 * A standing confirmation grant ("always allow this tool") survives, written
 * the way an adopter writes it — `createApp` + `createSession`, no harness
 * hand-wiring.
 *
 * Two independent routes, because they answer different questions:
 *   - Snapshot/restore — the grant is session state, so a session rehydrated
 *     from its own snapshot does not re-ask.
 *   - `onConfirmationResolved` + `confirmationPolicy` — the write/read pair
 *     an adopter uses to carry a grant somewhere the session cannot reach
 *     (a store, another session, the next process).
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { createApp } from "../react.js";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { ToolExecutorSnapshot } from "@agentick/tool-executor";
import type {
  ContentBlock,
  ProtocolEvent,
  ToolConfirmationResolution,
  ToolDeclaration,
} from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";
import { Chunk, Effect, Stream } from "effect";

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
    const env = Array.from(Chunk.toReadonlyArray(chunk))[0]!;
    const id = env.metadata?.correlationId;
    if (typeof id !== "string") throw new Error("expected correlationId");
    return id;
  });
}

describe("AppHarness — standing confirmation grants", () => {
  it("a grant approved before a snapshot is still held after the restore", async () => {
    const ran: string[] = [];
    const bus = new LocalEventBus();
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor("grant-snap-exec"),
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
      // A re-ask must fail fast rather than hang out the test timeout.
      toolExecutor: { defaultConfirmationTimeoutMs: 1_000 },
    });

    const first = await app.createSession();
    const idP = nextElicitationCorrelationId(bus);
    const dispatchP = first.tools.dispatch("delete-file", { path: "/tmp/x" });
    await first.elicitation.respond({
      correlationId: await idP,
      outcome: "accepted",
      value: { approved: true, always: true },
    });
    await dispatchP;

    const snapshot = await first.snapshot();
    expect((snapshot.bridges.toolExecutor as ToolExecutorSnapshot).alwaysAllowed).toEqual([
      "delete-file",
    ]);

    const second = await app.createSession();
    await second.restore({ snapshot });

    // No elicitation is answered for this one — the restored grant must cover it.
    await second.tools.dispatch("delete-file", { path: "/tmp/x" });

    // A fork is a spawn plus a restore, so the same grant reaches the child.
    const forked = await first.fork();
    await forked.tools.dispatch("delete-file", { path: "/tmp/x" });

    expect(ran).toEqual(["delete-file", "delete-file", "delete-file"]);

    await app.closeApp();
  });

  it("what the observer records, the policy reads back — a grant crossing sessions", async () => {
    const ran: string[] = [];
    const granted = new Set<string>();
    const resolutions: ToolConfirmationResolution[] = [];
    const bus = new LocalEventBus();
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor("grant-store-exec"),
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
      toolExecutor: {
        defaultConfirmationTimeoutMs: 1_000,
        onConfirmationResolved: (resolution) => {
          resolutions.push(resolution);
          if (resolution.outcome === "approved" && resolution.always === true) {
            granted.add(resolution.toolName);
          }
        },
        confirmationPolicy: ({ declaration, toolVerdict }) =>
          granted.has(declaration.name) ? false : toolVerdict,
      },
    });

    const first = await app.createSession();
    const idP = nextElicitationCorrelationId(bus);
    const dispatchP = first.tools.dispatch("delete-file", { path: "/tmp/x" });
    await first.elicitation.respond({
      correlationId: await idP,
      outcome: "accepted",
      value: { approved: true, always: true },
    });
    await dispatchP;

    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]).toMatchObject({
      toolName: "delete-file",
      sessionId: first.id,
      outcome: "approved",
      always: true,
    });

    // A session that never asked, and holds no in-memory grant of its own.
    const second = await app.createSession();
    await second.tools.dispatch("delete-file", { path: "/tmp/x" });

    expect(ran).toEqual(["delete-file", "delete-file"]);
    expect(resolutions).toHaveLength(1);

    await app.closeApp();
  });
});
