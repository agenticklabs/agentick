/**
 * Connector integration gate (ADR 58) — the full flow through a REAL
 * in-memory stack: `createGateway` → `createApp` → session, with the
 * connector installed as a gateway extension and a `fakeConnectorPlatform`
 * standing in for the external source.
 *
 * The thesis under test: a connector is an INGRESS binding — inbound
 * event → `session.send`. Outbound delivery and confirmation routing are
 * OPTIONAL halves, wired only when the platform opts in. A one-way
 * ingress-only source is first-class.
 */

import React from "react";
import { afterEach, describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { reactReconciler } from "@agentick/reconciler-react-next";
import { createGateway } from "@agentick/gateway-next";
import "@agentick/elicitation-next"; // side-effect: augment session.elicit/.elicitation
import { SPEC_VERSION, type ContentBlock, type ProtocolEvent } from "@agentick/spec-next";
import { waitFor } from "@agentick/utils-next/testing";

import { defineConnector } from "../define-connector.js";
import type { ConnectorConfig } from "../types.js";
import { fakeConnectorPlatform, type FakeConnectorPlatform } from "../testing/index.js";

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

const gateways: Array<{ close: () => Promise<void> }> = [];

async function buildStack(
  platform: FakeConnectorPlatform,
  config: ConnectorConfig,
  output: readonly ContentBlock[],
) {
  const gateway = await createGateway({
    extensions: [defineConnector({ name: "test", platform, config })],
  });
  gateways.push(gateway);
  await gateway.listen();
  const app = await gateway.createApp({
    rootElement: React.createElement(Agent),
    options: { executor: makeExec(output), reconciler: reactReconciler() } as never,
  });
  return { gateway, app };
}

afterEach(async () => {
  while (gateways.length) await gateways.pop()!.close();
});

// Declare an augmented telegram slot so `metadata.source` typechecks.
declare module "@agentick/spec-next" {
  interface MessageSource {
    readonly telegram?: { readonly chatId: number };
  }
}

describe("connector — inbound (a)", () => {
  it("emit → session.send runs and the user message carries metadata.source", async () => {
    const appended: ProtocolEvent[] = [];
    const platform = fakeConnectorPlatform();
    const { gateway } = await buildStack(platform, {}, [{ type: "text", text: "reply" }]);
    // Observe timeline appends on the shared gateway bus to inspect the
    // stamped provenance (gateway-created sessions use a noop timeline
    // handle, so we read the append envelope rather than session.timeline).
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

    platform.emit({ text: "hello agent", source: { telegram: { chatId: 42 } } });

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
    const completed: ProtocolEvent[] = [];
    const platform = fakeConnectorPlatform({ oneWay: true });
    expect(platform.deliver).toBeUndefined();
    expect(platform.presentConfirmation).toBeUndefined();

    const { gateway } = await buildStack(platform, {}, [{ type: "text", text: "processed" }]);
    const sub = (
      gateway as unknown as { events: (f: object) => AsyncIterable<ProtocolEvent> }
    ).events({
      surface: "loop",
      name: { exact: "loop:command:run-execution" },
      phase: "terminal",
    });
    void (async () => {
      for await (const e of sub) completed.push(e);
    })();

    platform.emit({ text: "webhook fired" });

    // The ingress action ran to completion …
    await waitFor(() => (completed.length > 0 ? true : undefined), {
      description: "the ingress execution completed",
      timeoutMs: 3000,
    });
    // … and nothing was delivered back (one-way source).
    expect(platform.delivered).toHaveLength(0);
  });
});

describe("connector — outbound (optional deliver)", () => {
  it("hands the agent's raw output to a platform that implements deliver", async () => {
    const platform = fakeConnectorPlatform();
    await buildStack(platform, {}, [{ type: "text", text: "the answer is 42" }]);
    platform.emit({ text: "what is the answer" });
    await waitFor(() => (platform.delivered.length > 0 ? true : undefined), {
      description: "output delivered to the platform",
      timeoutMs: 3000,
    });
    const delivery = platform.delivered[0]!;
    expect(delivery.response).toContain("the answer is 42");
    expect(delivery.output).toHaveLength(1);
    expect(delivery.output[0]).toMatchObject({ type: "text", text: "the answer is 42" });
  });
});

describe("connector — confirmations (optional)", () => {
  it("presents an elicitation and routes the reply through respond()", async () => {
    const platform = fakeConnectorPlatform();
    const { app } = await buildStack(platform, {}, [{ type: "text", text: "ok" }]);

    // Establish the managed session via an inbound event.
    platform.emit({ text: "start" });
    await waitFor(() => (app.getSession("connector:test") ? true : undefined), {
      description: "connector session exists",
      timeoutMs: 3000,
    });
    const session = app.getSession("connector:test") as unknown as {
      elicit: { confirm: (m: string) => Promise<boolean> };
    };

    const confirmP = session.elicit.confirm("Delete everything?");
    await waitFor(() => (platform.confirmations.length > 0 ? true : undefined), {
      description: "platform receives a confirmation prompt",
      timeoutMs: 3000,
    });
    expect(platform.confirmations[0]!.message).toContain("Delete everything?");

    platform.replyLatest("yes");
    expect(await confirmP).toBe(true);
  });

  it("a 'no' reply answers the confirmation with false (not a dismissal)", async () => {
    const platform = fakeConnectorPlatform();
    const { app } = await buildStack(platform, {}, [{ type: "text", text: "ok" }]);
    platform.emit({ text: "start" });
    await waitFor(() => (app.getSession("connector:test") ? true : undefined), {
      description: "session exists",
      timeoutMs: 3000,
    });
    const session = app.getSession("connector:test") as unknown as {
      elicit: { confirm: (m: string) => Promise<boolean> };
    };
    const confirmP = session.elicit.confirm("Proceed?");
    await waitFor(() => (platform.confirmations.length > 0 ? true : undefined), {
      description: "prompt presented",
      timeoutMs: 3000,
    });
    platform.replyLatest("no");
    expect(await confirmP).toBe(false);
  });
});
