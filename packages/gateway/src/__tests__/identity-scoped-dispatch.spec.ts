/**
 * The `as()` doors — identity-scoped dispatch on the local pole.
 *
 * `gateway.as(identity).app(id)` runs the SAME mechanism a transport dispatch
 * runs — verb-scope authorization, the `wire:app/create_session` op, the
 * adopter's `onBeforeWire…` hooks with `ctx.identity` populated, the ADR-48
 * principal stamp — with no framing and a LOCAL harness at the end.
 * `app.as(identity)` is the attribution-only half: the stamp and the
 * identity-carrying op scope, no gateway policy (an app alone has none).
 *
 * The trust contract under test: the identity is the authority (a
 * caller-supplied `principal` in the input is clobbered), and the bare local
 * pole stays untouched (no wire hooks, no stamp, nothing second-guessed).
 */

import { describe, expect, it } from "vitest";
import type { ContentBlock, IngressIdentity } from "@agentick/spec";
import { SPEC_VERSION, WireRpcError } from "@agentick/spec";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { CompilerHarness } from "@agentick/compiler-react";

import { createGateway, permissiveAuthorizer } from "../index.js";

const NULL_ROOT = null as unknown;

function mkAppOptions() {
  const sub = { journal: new MemoryJournal(), bus: new LocalEventBus(), inbox: new LocalInbox() };
  return {
    modelExecutor: new FakeLanguageModelExecutor(
      `exec-${Math.random().toString(36).slice(2)}`,
      sub.journal,
      sub.bus,
      sub.inbox,
      {
        scripted: {
          result: {
            specVersion: SPEC_VERSION,
            output: [{ type: "text", text: "ok" } satisfies ContentBlock],
            stopReason: "end",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          },
        },
      },
    ),
    compiler: new CompilerHarness(
      `r-${Math.random().toString(36).slice(2)}`,
      sub.journal,
      sub.bus,
      sub.inbox,
    ),
  };
}

const IDENTITY: IngressIdentity = {
  principal: "tenant-1:user-9",
  user: { tenantId: "tenant-1", userId: "user-9" },
  scopes: [],
};

async function mkGateway() {
  const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
  await gateway.listen();
  const app = await gateway.createApp({
    appId: "classifier",
    rootElement: NULL_ROOT,
    options: mkAppOptions(),
  });
  return { gateway, app };
}

describe("gateway.as(identity) — the wire mechanism without the framing", () => {
  it("createSession stamps the ADR-48 principal from the identity", async () => {
    const { gateway } = await mkGateway();
    const session = await gateway.as(IDENTITY).app("classifier")!.createSession();
    expect(session.principal).toBe("tenant-1:user-9");
    await gateway.close();
  });

  it("a caller-supplied principal is clobbered — the identity is the authority", async () => {
    const { gateway } = await mkGateway();
    const session = await gateway
      .as(IDENTITY)
      .app("classifier")!
      .createSession({ principal: "forged:owner" });
    expect(session.principal).toBe("tenant-1:user-9");
    await gateway.close();
  });

  it("adopter onBeforeWireAppCreateSession hooks fire with ctx.identity and their reshape is honored", async () => {
    const { gateway } = await mkGateway();
    const seen: { identity?: IngressIdentity } = {};
    gateway.hook({
      onBeforeWireAppCreateSession: <P extends { readonly metadata?: Record<string, unknown> }>(
        params: P,
        ctx: { readonly identity?: IngressIdentity },
      ): P => {
        seen.identity = ctx.identity;
        return { ...params, metadata: { ...params.metadata, stamped: ctx.identity?.user } };
      },
    });

    const session = await gateway.as(IDENTITY).app("classifier")!.createSession();
    expect(seen.identity).toEqual(IDENTITY);
    const record = await gateway.app("classifier")!.getSessionRecord(session.id);
    expect(record?.metadata?.stamped).toEqual({ tenantId: "tenant-1", userId: "user-9" });
    await gateway.close();
  });

  it("the bare local pole stays untouched — no wire hooks, no stamp", async () => {
    const { gateway, app } = await mkGateway();
    let fired = 0;
    gateway.hook({
      onBeforeWireAppCreateSession: <P>(params: P): P => {
        fired += 1;
        return params;
      },
    });

    const session = await app.createSession({ principal: "host:chosen" });
    expect(fired).toBe(0);
    expect(session.principal).toBe("host:chosen");
    await gateway.close();
  });

  it("the default unconfigured authorizer denies an authenticated principal — same as the wire", async () => {
    const gateway = await createGateway();
    await gateway.listen();
    await gateway.createApp({
      appId: "classifier",
      rootElement: NULL_ROOT,
      options: mkAppOptions(),
    });

    await expect(gateway.as(IDENTITY).app("classifier")!.createSession()).rejects.toThrow(
      WireRpcError,
    );
    await gateway.close();
  });

  it("app() resolves like the unscoped accessor — undefined for an unknown id", async () => {
    const { gateway } = await mkGateway();
    expect(gateway.as(IDENTITY).app("nope")).toBeUndefined();
    await gateway.close();
  });

  it("runOnce crosses as the identity: ephemeral session stamped, adopter hook sees the create", async () => {
    const { gateway, app } = await mkGateway();
    // Wire parity: params do NOT carry the principal at hook time (the ADR-48
    // stamp is the handler's, downstream of the hooks) — a policy hook reads
    // WHO from ctx, exactly as on a transport dispatch.
    const stamped: { principal?: string } = {};
    gateway.hook({
      onBeforeWireAppCreateSession: <P>(
        params: P,
        ctx: { readonly identity?: IngressIdentity },
      ): P => {
        stamped.principal = ctx.identity?.principal;
        return params;
      },
    });

    const { result, sessionId } = await gateway
      .as(IDENTITY)
      .app("classifier")!
      .runOnce({ send: { messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] } });

    expect(stamped.principal).toBe("tenant-1:user-9");
    expect(result.response).toBe("ok");
    expect(app.getSession(sessionId)).toBeUndefined(); // disposed after the run
    await gateway.close();
  });
});

describe("app.as(identity) — attribution without gateway policy", () => {
  it("stamps createSession and runOnce, no wire op involved", async () => {
    const { gateway, app } = await mkGateway();
    let wireFired = 0;
    gateway.hook({
      onBeforeWireAppCreateSession: <P>(params: P): P => {
        wireFired += 1;
        return params;
      },
    });

    const session = await app.as(IDENTITY).createSession({ principal: "forged" });
    expect(session.principal).toBe("tenant-1:user-9");

    const { result } = await app.as(IDENTITY).runOnce({
      send: { messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] },
    });
    expect(result.response).toBe("ok");

    expect(wireFired).toBe(0);
    await gateway.close();
  });
});
