/**
 * ADR 100 law 4 — `from` on the wire's create door is a cross-session STATE
 * READ, and the gateway is the only thing standing in front of it.
 *
 * `from.inherited` fans the SOURCE session's timeline, knobs and state into the
 * new session, and the new session belongs to whoever asked for it. So a `from`
 * naming a session the caller does not own is not a bad parameter — it is a
 * verbatim copy of another principal's conversation, handed to the caller
 * through a door they are allowed to open.
 *
 * The dispatch gate cannot catch this: its same-principal rule resolves a TARGET
 * from `params.sessionId`, and a create names no target — the session does not
 * exist yet. The source id rides in a different field, and nothing above the
 * handler reads it.
 *
 * The law is the DOOR's, not the wire's: `gateway.as(identity)` claims an
 * identity the same way and reaches the same app, so it runs the same guard and
 * is pinned here beside the wire's. Address resolution rides along — a `from`
 * with no `appId` resolves the app from the source, which makes "which app hosts
 * this id" an answer the refusal must not leak either.
 *
 * Driven through `fakeWireCaller` so this is the real `app/create_session`
 * handler over real apps and real durable records, with the ingress principal
 * given rather than resolved.
 *
 * @verifiedBy this file
 * @see packages/gateway/src/wire/session-list.ts — `mayBranchFrom`
 * @see docs/proposals/v2/blueprint/100-conversation-branches.md — law 4
 */

import { describe, expect, it } from "vitest";
import { AppNotFoundError, ErrorCode, SPEC_VERSION, type ContentBlock } from "@agentick/spec";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { CompilerHarness } from "@agentick/compiler-react";

import { createGateway, permissiveAuthorizer } from "../index.js";
import { fakeWireCaller } from "../testing/index.js";

const NULL_ROOT = null as unknown;

function mkAppOptions() {
  const sub = { journal: new MemoryJournal(), bus: new LocalEventBus(), inbox: new LocalInbox() };
  const id = Math.random().toString(36).slice(2);
  return {
    executor: new FakeLanguageModelExecutor(`exec-${id}`, sub.journal, sub.bus, sub.inbox, {
      scripted: {
        result: {
          specVersion: SPEC_VERSION,
          output: [{ type: "text", text: "ok" } satisfies ContentBlock],
          stopReason: "end" as const,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
      },
    }),
    compiler: new CompilerHarness(`r-${id}`, sub.journal, sub.bus, sub.inbox),
  };
}

/**
 * A gateway holding TWO apps — the source session lives in the first, owned by
 * `principal`. The second app is what makes "which app hosts this session" a
 * question with a wrong answer, which is what address resolution can leak.
 */
async function rig(principal?: string) {
  const gateway = await createGateway({ authorizer: permissiveAuthorizer() });
  await gateway.listen();
  const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
  const elsewhere = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
  await app.createSession({
    sessionId: "source",
    eager: true,
    ...(principal !== undefined ? { principal } : {}),
  });
  return { gateway, app, elsewhere };
}

/** No `entryId`: at the door that means the source's tip, and this source has none. */
const branchOfSource = { sessionId: "source", inherited: true, anchored: false };

describe("app/create_session — who may branch from whom (ADR 100 law 4)", () => {
  it("refuses a `from` naming another principal's session", async () => {
    const { gateway, app } = await rig("alice");

    const call = fakeWireCaller({ apps: [app], principal: "mallory" }).call("app/create_session", {
      appId: app.id,
      sessionId: "mallorys-copy",
      from: branchOfSource,
    });

    await expect(call).rejects.toMatchObject({ code: ErrorCode.Forbidden });
    // Refused BEFORE anything was created: a session that exists is a session
    // whose genesis already ran the fan-out this guard exists to prevent.
    expect(app.getSession("mallorys-copy")).toBeUndefined();
    expect(await app.getSessionRecord("mallorys-copy")).toBeUndefined();

    await gateway.close();
  });

  it("admits the source's own owner", async () => {
    const { gateway, app } = await rig("alice");

    const result = await fakeWireCaller({ apps: [app], principal: "alice" }).call<{
      sessionId: string;
    }>("app/create_session", { appId: app.id, sessionId: "alices-fork", from: branchOfSource });

    expect(result.sessionId).toBe("alices-fork");

    await gateway.close();
  });

  it("refuses a source that does not exist, identically", async () => {
    // Same code, same message: a distinct "no such session" would answer, for
    // any id a caller cares to name, whether that session exists.
    const { gateway, app } = await rig("alice");
    const wire = fakeWireCaller({ apps: [app], principal: "mallory" });

    const unowned = await wire
      .call("app/create_session", { appId: app.id, from: branchOfSource })
      .catch((error: unknown) => error);
    const absent = await wire
      .call("app/create_session", {
        appId: app.id,
        from: { ...branchOfSource, sessionId: "no-such-session" },
      })
      .catch((error: unknown) => error);

    expect(absent).toMatchObject({ code: ErrorCode.Forbidden });
    expect((absent as Error).message).toBe((unowned as Error).message);

    await gateway.close();
  });

  it("admits any caller when the source asserts no ownership", async () => {
    // The principal-less deployment / local pole, and the same rule `visibleTo`
    // states for the list and destroy doors: an unstamped record is open.
    const { gateway, app } = await rig();

    const result = await fakeWireCaller({ apps: [app], principal: "anyone" }).call<{
      sessionId: string;
    }>("app/create_session", { appId: app.id, sessionId: "local-fork", from: branchOfSource });

    expect(result.sessionId).toBe("local-fork");

    await gateway.close();
  });

  it("leaves a create with no `from` alone", async () => {
    // The guard reads the source record, so an unconditional read would have
    // made every plain create pay for a lookup — and a create by a caller who
    // owns nothing would have been refused for naming nothing.
    const { gateway, app } = await rig("alice");

    const result = await fakeWireCaller({ apps: [app], principal: "mallory" }).call<{
      sessionId: string;
    }>("app/create_session", { appId: app.id, sessionId: "mallorys-own" });

    expect(result.sessionId).toBe("mallorys-own");

    await gateway.close();
  });
});

describe("app/create_session — the app a branch lands in", () => {
  it("resolves the app from the source when the caller names none", async () => {
    // A client holding a session id can fork it without also carrying the app
    // id: a branch lives where the conversation it came from lives.
    const { gateway, app, elsewhere } = await rig("alice");

    const result = await fakeWireCaller({ apps: [app, elsewhere], principal: "alice" }).call<{
      sessionId: string;
    }>("app/create_session", { sessionId: "alices-fork", from: branchOfSource });

    expect(result.sessionId).toBe("alices-fork");
    // Live, not durable: a branch is a conversation, and a conversation earns
    // its row at the first turn (law 3). In the SOURCE's app, and only there —
    // resolution is not a guess.
    expect(app.getSession("alices-fork")).toBeDefined();
    expect(elsewhere.getSession("alices-fork")).toBeUndefined();

    await gateway.close();
  });

  it("refuses an `appId` that is not the source's app, and says nothing more", async () => {
    // Resolution answers "which app hosts this id", so the wrong-app refusal has
    // to be the refusal a caller gets for a source they do not own and for one
    // that does not exist. Three separable failures would let anyone map every
    // session on the gateway by trying an id against each app in turn.
    const { gateway, app, elsewhere } = await rig("alice");
    const wire = fakeWireCaller({ apps: [app, elsewhere], principal: "alice" });

    const wrongApp = await wire
      .call("app/create_session", { appId: elsewhere.id, from: branchOfSource })
      .catch((error: unknown) => error);
    const absent = await wire
      .call("app/create_session", { from: { ...branchOfSource, sessionId: "no-such-session" } })
      .catch((error: unknown) => error);

    expect(wrongApp).toMatchObject({ code: ErrorCode.Forbidden });
    expect((wrongApp as Error).message).toBe((absent as Error).message);
    expect(await elsewhere.getSessionRecord("source")).toBeUndefined();

    await gateway.close();
  });

  it("admits an `appId` that agrees with the source's app", async () => {
    const { gateway, app, elsewhere } = await rig("alice");

    const result = await fakeWireCaller({ apps: [app, elsewhere], principal: "alice" }).call<{
      sessionId: string;
    }>("app/create_session", { appId: app.id, sessionId: "agreed", from: branchOfSource });

    expect(result.sessionId).toBe("agreed");

    await gateway.close();
  });

  it("still needs an `appId` for a plain create — there is nothing to resolve from", async () => {
    const { gateway, app, elsewhere } = await rig("alice");

    const call = fakeWireCaller({ apps: [app, elsewhere], principal: "alice" }).call(
      "app/create_session",
      { sessionId: "nowhere" },
    );

    await expect(call).rejects.toThrow(AppNotFoundError);

    await gateway.close();
  });
});

describe("gateway.as(identity) — the local door runs the same law", () => {
  // The other door that claims an identity. It reaches the same app with the
  // same input, so guarding only the wire would make ownership a property of
  // which entry point a connector happened to use.
  it("refuses a `from` naming another principal's session", async () => {
    const { gateway, app } = await rig("alice");

    const call = gateway
      .as({ principal: "mallory", scopes: ["*"] })
      .app(app.id)!
      .createSession({ sessionId: "mallorys-copy", from: branchOfSource });

    await expect(call).rejects.toMatchObject({ code: ErrorCode.Forbidden });
    expect(app.getSession("mallorys-copy")).toBeUndefined();

    await gateway.close();
  });

  it("admits the source's own owner", async () => {
    const { gateway, app } = await rig("alice");

    const session = await gateway
      .as({ principal: "alice", scopes: ["*"] })
      .app(app.id)!
      .createSession({ sessionId: "alices-fork", from: branchOfSource });

    expect(session.id).toBe("alices-fork");
    expect(session.principal).toBe("alice");

    await gateway.close();
  });
});
