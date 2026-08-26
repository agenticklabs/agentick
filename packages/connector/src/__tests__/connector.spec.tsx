/**
 * End-to-end over the REAL gateway + app + session: the flat-spec API's four
 * halves — inbound provenance, one-way ingress, optional deliver, optional
 * confirmations — driven through `connectorProbe()`.
 */

import React from "react";
import { afterEach, describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { reactCompiler } from "@agentick/compiler-react";
import { createGateway, type GatewayHarness } from "@agentick/gateway";
import "@agentick/elicitation"; // side-effect: augment session.elicit/.elicitation
import { SPEC_VERSION, type ContentBlock, type ProtocolEvent } from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { defineConnector } from "../define-connector.js";
import type { ConnectorSpec } from "../types.js";
import { connectorProbe, type ConnectorProbe } from "../testing/index.js";

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

async function buildStack(
  probe: ConnectorProbe,
  spec: Partial<ConnectorSpec>,
  output: readonly ContentBlock[],
) {
  const gateway = await createGateway({
    extensions: [defineConnector({ name: "test", ...probe.spec, ...spec })],
  });
  gateways.push(gateway);
  await gateway.listen();
  const app = await gateway.createApp({
    rootElement: React.createElement(Agent),
    options: { modelExecutor: makeExec(output), compiler: reactCompiler() },
  });
  return { gateway, app };
}

afterEach(async () => {
  while (gateways.length) await gateways.pop()!.close();
});

// Declare an augmented telegram slot so `metadata.source` typechecks.
declare module "@agentick/spec" {
  interface MessageSource {
    readonly telegram?: { readonly chatId: number };
  }
}

describe("connector — inbound", () => {
  it("emit → session.send runs and the user message carries metadata.source", async () => {
    const appended: ProtocolEvent[] = [];
    const probe = connectorProbe();
    const { gateway } = await buildStack(probe, {}, [{ type: "text", text: "reply" }]);
    const sub = (
      gateway as unknown as { events: (f: object) => AsyncIterable<ProtocolEvent> }
    ).events({
      surface: "timeline",
      name: { exact: "timeline:command:append" },
      phase: "requested",
    });
    void (async () => {
      for await (const e of sub) appended.push(e);
    })();

    probe.emit({ messages: "hello agent", source: { telegram: { chatId: 42 } } });

    await waitFor(() => (appended.length > 0 ? true : undefined), {
      description: "a timeline append is observed",
      timeoutMs: 3000,
    });

    const stamped = appended.find((e) => {
      const payload = e.payload as {
        entries?: Array<{ message?: { metadata?: Record<string, unknown> } }>;
      };
      return payload?.entries?.some(
        (entry) =>
          (entry.message?.metadata?.source as { telegram?: { chatId: number } })?.telegram
            ?.chatId === 42,
      );
    });
    expect(stamped).toBeDefined();
  });
});

describe("connector — one-way ingress (no deliver)", () => {
  it("inbound-only: event → session.send runs, nothing delivered back", async () => {
    const probe = connectorProbe({ oneWay: true });
    expect(probe.spec.deliver).toBeUndefined();
    expect(probe.spec.confirm).toBeUndefined();

    const { app } = await buildStack(probe, {}, [{ type: "text", text: "reply" }]);
    probe.emit({ messages: "webhook fired" });

    await waitFor(() => (app.getSession("connector:test") ? true : undefined), {
      description: "session created by the inbound event",
      timeoutMs: 3000,
    });
    expect(probe.delivered).toHaveLength(0);
  });
});

describe("connector — outbound (optional deliver)", () => {
  it("hands the agent's raw output to a spec that implements deliver", async () => {
    const probe = connectorProbe();
    await buildStack(probe, {}, [{ type: "text", text: "the answer is 42" }]);

    probe.emit({ messages: "what is the answer" });
    await waitFor(() => (probe.delivered.length > 0 ? true : undefined), {
      description: "delivery observed",
      timeoutMs: 3000,
    });
    const delivery = probe.delivered[0]!;
    expect(delivery.response).toContain("the answer is 42");
    expect(delivery.output).toHaveLength(1);
    expect(delivery.output[0]).toMatchObject({ type: "text", text: "the answer is 42" });
  });
});

describe("connector — confirmations (optional)", () => {
  async function confirmVia(probe: ConnectorProbe, replyText: string): Promise<boolean> {
    const { app } = await buildStack(probe, {}, [{ type: "text", text: "ok" }]);
    probe.emit({ messages: "start" });
    await waitFor(() => (app.getSession("connector:test") ? true : undefined), {
      description: "connector session exists",
      timeoutMs: 3000,
    });
    const session = app.getSession("connector:test") as unknown as {
      elicit: { confirm: (m: string) => Promise<boolean> };
    };
    const confirmP = session.elicit.confirm("Proceed?");
    await waitFor(() => (probe.prompts.length > 0 ? true : undefined), {
      description: "prompt presented",
      timeoutMs: 3000,
    });
    probe.reply({ correlationId: probe.prompts.at(-1)!.correlationId, text: replyText });
    return confirmP;
  }

  it("presents an elicitation and a 'yes' routes back as approved", async () => {
    const probe = connectorProbe();
    expect(await confirmVia(probe, "yes")).toBe(true);
    expect(probe.prompts[0]!.message).toContain("Proceed?");
  });

  it("a 'no' reply answers the confirmation with false (not a dismissal)", async () => {
    const probe = connectorProbe();
    expect(await confirmVia(probe, "no")).toBe(false);
  });
});

describe("connector — teardown", () => {
  it("gateway close runs the teardown returned by start", async () => {
    const probe = connectorProbe();
    const { gateway } = await buildStack(probe, {}, [{ type: "text", text: "reply" }]);
    expect(probe.stopped).toBe(false);
    await gateway.close();
    gateways.pop();
    expect(probe.stopped).toBe(true);
  });
});
