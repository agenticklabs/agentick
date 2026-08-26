/**
 * The web-streams faces: `spec.stream` hands each connector-initiated turn
 * over as a live ReadableStream (events or the text() projection), and
 * `ctx.writable()` accepts a piped source where every chunk becomes an
 * inbound event.
 */

import React from "react";
import { afterEach, describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { reactCompiler } from "@agentick/compiler-react";
import { createGateway, type GatewayHarness } from "../index.js";
import { SPEC_VERSION, type ContentBlock } from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { defineConnector } from "@agentick/connector";
import type { ConnectorContext, StreamingTurn } from "@agentick/spec";

function Agent() {
  return React.createElement("message" as never, { role: "user" }, "ping");
}

function makeExec(output: readonly ContentBlock[]) {
  return new FakeLanguageModelExecutor(
    `exec-${Math.random().toString(36).slice(2)}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: {
        result: {
          specVersion: SPEC_VERSION,
          output: [...output],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    },
  );
}

const gateways: GatewayHarness[] = [];

afterEach(async () => {
  while (gateways.length) await gateways.pop()!.close();
});

async function collect(readable: ReadableStream<string>): Promise<string> {
  let text = "";
  const reader = readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += value;
  }
}

describe("connector — streaming", () => {
  it("spec.stream receives each turn live; text() pipes the assistant's words", async () => {
    let ctx!: ConnectorContext;
    const turns: StreamingTurn[] = [];
    const texts: string[] = [];

    const gateway = await createGateway({
      connectors: [
        defineConnector({
          name: "live",
          start(c) {
            ctx = c;
          },
          stream: async (turn) => {
            turns.push(turn);
            texts.push(await collect(turn.text()));
          },
        }),
      ],
    });
    gateways.push(gateway);
    await gateway.listen();
    await gateway.createApp({
      rootElement: React.createElement(Agent),
      options: {
        modelExecutor: makeExec([{ type: "text", text: "the answer is 42" }]),
        compiler: reactCompiler(),
      },
    });

    ctx.inbound({ messages: "what is the answer" });

    await waitFor(() => (texts.length > 0 ? true : undefined), {
      description: "streamed text collected",
      timeoutMs: 3000,
    });

    expect(texts[0]).toBe("the answer is 42");
    expect(turns[0]!.executionId).toBeTruthy();
    await expect(turns[0]!.result).resolves.toMatchObject({ response: "the answer is 42" });
  });

  it("ctx.writable(): a piped source becomes inbound events, chunk by chunk", async () => {
    let ctx!: ConnectorContext;
    const delivered: string[] = [];

    const gateway = await createGateway({
      connectors: [
        defineConnector({
          name: "piped",
          start(c) {
            ctx = c;
          },
          deliver: ({ response }) => {
            delivered.push(response);
          },
        }),
      ],
    });
    gateways.push(gateway);
    await gateway.listen();
    await gateway.createApp({
      rootElement: React.createElement(Agent),
      options: {
        modelExecutor: makeExec([{ type: "text", text: "ack" }]),
        compiler: reactCompiler(),
      },
    });

    // Distinct sessions per chunk: same-session chunks would STEER into the
    // in-flight turn (the right behavior for a chat source; not what this
    // test observes).
    const source = new ReadableStream<{ messages: string; sessionId: string }>({
      start(controller) {
        controller.enqueue({ messages: "first line", sessionId: "pipe-1" });
        controller.enqueue({ messages: "second line", sessionId: "pipe-2" });
        controller.close();
      },
    });
    await source.pipeTo(ctx.writable());

    await waitFor(() => (delivered.length >= 2 ? true : undefined), {
      description: "both piped chunks produced turns",
      timeoutMs: 5000,
    });
    expect(delivered).toHaveLength(2);
  });
});
