/**
 * The three source-agnostic seams added for identity-bearing connectors
 * (ADR 58 + ADR 100): an inbound event may carry an AUTHENTICATED identity
 * (session opens through the gateway's `as()` door — principal stamped, adopter
 * wire hooks fire), a session-opening contribution (metadata/title), and
 * `mode: "ephemeral"` (runOnce + direct deliver, no held session).
 */

import React from "react";
import { afterEach, describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { reactCompiler } from "@agentick/compiler-react";
import { createGateway, permissiveAuthorizer, type GatewayHarness } from "@agentick/gateway";
import { SPEC_VERSION, type ContentBlock, type IngressIdentity } from "@agentick/spec";
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

const IDENTITY: IngressIdentity = {
  principal: "tenant-1:user-9",
  user: { tenantId: "tenant-1", userId: "user-9" },
  scopes: [],
};

const gateways: GatewayHarness[] = [];

async function buildStack(probe: ConnectorProbe, spec: Partial<ConnectorSpec>) {
  const gateway = await createGateway({
    authorizer: permissiveAuthorizer(),
    extensions: [defineConnector({ name: "test", ...probe.spec, ...spec })],
  });
  gateways.push(gateway);
  await gateway.listen();
  const app = await gateway.createApp({
    rootElement: React.createElement(Agent),
    options: {
      modelExecutor: makeExec([{ type: "text", text: "reply" }]),
      compiler: reactCompiler(),
    },
  });
  return { gateway, app };
}

afterEach(async () => {
  while (gateways.length) await gateways.pop()!.close();
});

describe("connector — identity + session init + ephemeral", () => {
  it("an inbound identity opens the session through as(): principal stamped, init merged", async () => {
    const probe = connectorProbe();
    const { app } = await buildStack(probe, {});

    probe.emit({
      content: "hello",
      identity: IDENTITY,
      sessionId: "sms-thread-1",
      session: { title: "Text conversation", metadata: { channel: "sms" } },
    });

    await waitFor(() => (app.getSession("sms-thread-1") ? true : undefined), {
      description: "session opened",
      timeoutMs: 3000,
    });

    expect(app.getSession("sms-thread-1")?.principal).toBe("tenant-1:user-9");
    const record = await app.getSessionRecord("sms-thread-1");
    expect(record?.metadata?.channel).toBe("sms");
    expect(record?.title).toBe("Text conversation");
  });

  it("without an identity the bare local pole is unchanged (no stamp)", async () => {
    const probe = connectorProbe();
    const { app } = await buildStack(probe, {});

    probe.emit({ content: "hello", sessionId: "plain-1" });
    await waitFor(() => (app.getSession("plain-1") ? true : undefined), {
      description: "session opened",
      timeoutMs: 3000,
    });

    expect(app.getSession("plain-1")?.principal).toBeUndefined();
  });

  it("ephemeral mode runs once, delivers directly, and holds no session", async () => {
    const probe = connectorProbe();
    const { app } = await buildStack(probe, { ephemeral: true });

    probe.emit({ content: "classify this", identity: IDENTITY });

    await waitFor(() => (probe.delivered.length > 0 ? true : undefined), {
      description: "runOnce result delivered",
      timeoutMs: 3000,
    });

    expect(probe.delivered[0]!.response).toBe("reply");
    expect(app.getSession(probe.delivered[0]!.sessionId)).toBeUndefined();
  });
});

describe("connector — registry", () => {
  it("self-registers; host deliver flows; ingress-only throws", async () => {
    const delivered: string[] = [];
    let ingressOnlyHandleErr: Error | undefined;
    const gateway = await createGateway({
      extensions: [
        defineConnector({
          name: "notify",
          start: () => undefined,
          deliver: ({ response }) => {
            delivered.push(response);
          },
        }),
        defineConnector({ name: "intake", start: () => undefined }),
      ],
    });
    gateways.push(gateway);
    await gateway.listen();

    const { connectors } = await import("../registry.js");
    const registry = connectors(gateway);
    expect(
      registry
        .list()
        .map((c) => c.name)
        .sort(),
    ).toEqual(["intake", "notify"]);
    expect(registry.get("notify")?.status).toBe("connected");

    await registry.get("notify")!.deliver({ sessionId: "s1", response: "heads up" });
    expect(delivered).toEqual(["heads up"]);

    await registry
      .get("intake")!
      .deliver({ sessionId: "s1", response: "x" })
      .catch((e) => {
        ingressOnlyHandleErr = e;
      });
    expect(ingressOnlyHandleErr?.message).toContain("ingress-only");
  });
});
