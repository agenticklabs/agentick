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
import { createGateway, permissiveAuthorizer, type GatewayHarness } from "../index.js";
import {
  SPEC_VERSION,
  type Authorizer,
  type ContentBlock,
  type IngressIdentity,
} from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { defineConnector } from "@agentick/connector";
import type { ConnectorSpec } from "@agentick/spec";
import * as blocks from "@agentick/spec/blocks";
import { connectorProbe, type ConnectorProbe } from "@agentick/connector/testing";

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

async function buildStack(
  probe: ConnectorProbe,
  spec: Partial<ConnectorSpec>,
  opts: { authorizer?: Authorizer } = {},
) {
  const gateway = await createGateway({
    authorizer: opts.authorizer ?? permissiveAuthorizer(),
    connectors: [defineConnector({ name: "test", ...probe.spec, ...spec })],
  });
  gateways.push(gateway);
  await gateway.listen();
  const app = await gateway.createApp({
    rootElement: React.createElement(Agent),
    options: {
      modelExecutor: makeExec([blocks.text("reply")]),
      compiler: reactCompiler(),
    },
  });
  return { gateway, app };
}

/**
 * The identity pair every execution under this gateway ran as — `principal`
 * (the owner, the scope key) and `actor` (who the turn was for) — read off the
 * run op's scope by a gateway-level middleware, which the ADR 84 cascade folds
 * down through the app into each session's loop.
 */
function observeIdentity(gateway: GatewayHarness): { principal?: string; actor?: string }[] {
  const seen: { principal?: string; actor?: string }[] = [];
  gateway.use(async (input, next, ctx) => {
    if (ctx.opId?.startsWith("loop:execution:")) {
      seen.push({ principal: ctx.principal, actor: (ctx as { actor?: string }).actor });
    }
    return next(input);
  });
  return seen;
}

/** Admits anyone to anything — the shape an adopter uses to let staff into a customer's session. */
const allowAll: Authorizer = {
  backend: "allow-all",
  authorize: () => Promise.resolve({ allowed: true }),
};

afterEach(async () => {
  while (gateways.length) await gateways.pop()!.close();
});

describe("connector — identity + session init + ephemeral", () => {
  it("an inbound identity opens the session through as(): principal stamped, init merged", async () => {
    const probe = connectorProbe();
    const { app } = await buildStack(probe, {});

    probe.emit({
      messages: "hello",
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

    probe.emit({ messages: "hello", sessionId: "plain-1" });
    await waitFor(() => (app.getSession("plain-1") ? true : undefined), {
      description: "session opened",
      timeoutMs: 3000,
    });

    expect(app.getSession("plain-1")?.principal).toBeUndefined();
  });

  it("ephemeral mode runs once, delivers directly, and holds no session", async () => {
    const probe = connectorProbe();
    const { app } = await buildStack(probe, { ephemeral: true });

    probe.emit({ messages: "classify this", identity: IDENTITY });

    await waitFor(() => (probe.delivered.length > 0 ? true : undefined), {
      description: "runOnce result delivered",
      timeoutMs: 3000,
    });

    expect(probe.delivered[0]!.response).toBe("reply");
    expect(app.getSession(probe.delivered[0]!.sessionId)).toBeUndefined();
  });
});

describe("connector — gateway.connectors", () => {
  it("registers via the slot; host deliver flows; ingress-only throws", async () => {
    const delivered: string[] = [];
    let ingressOnlyHandleErr: Error | undefined;
    const gateway = await createGateway({
      connectors: [
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

    const registry = gateway.connectors;
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

  it("an identity-bearing inbound into a session owned by someone else stamps the inbound's identity as the actor, owner unchanged", async () => {
    const probe = connectorProbe();
    const { gateway, app } = await buildStack(probe, {}, { authorizer: allowAll });
    const seen = observeIdentity(gateway);
    const owner = await app.createSession({ sessionId: "bound-1", principal: "tenant-1:user-1" });
    expect(owner.principal).toBe("tenant-1:user-1");

    probe.emit({ messages: "a note from staff", sessionId: "bound-1", identity: IDENTITY });
    await waitFor(() => seen.length > 0);
    await waitFor(() => app.getSession("bound-1")?.status !== "running");

    expect(seen).toEqual([{ principal: "tenant-1:user-1", actor: IDENTITY.principal }]);
    expect(app.getSession("bound-1")?.principal).toBe("tenant-1:user-1");
  });

  it("an inbound without identity into an owned session runs as the owner, as before", async () => {
    const probe = connectorProbe();
    const { gateway, app } = await buildStack(probe, {}, { authorizer: allowAll });
    const seen = observeIdentity(gateway);
    await app.createSession({ sessionId: "bound-2", principal: "tenant-1:user-1" });

    probe.emit({ messages: "hello", sessionId: "bound-2" });
    await waitFor(() => seen.length > 0);
    await waitFor(() => app.getSession("bound-2")?.status !== "running");

    expect(seen).toEqual([{ principal: "tenant-1:user-1", actor: undefined }]);
  });
});
