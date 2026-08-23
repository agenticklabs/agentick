/**
 * The session DOORS (docs/proposals/v2/session-doors.md slice 1), pinned against
 * the real gateway → app → session stack rather than a stubbed inbox: eviction
 * has to genuinely unmount the surface for the resume door to be under test.
 *
 * The design law each test enforces: the client speaks existence and interaction
 * verbs; create and resume are doors the FRAMEWORK takes because a verb required
 * it. So `session/send` never 404s (it creates), reads never create, and
 * `session/get` never mounts anything at all.
 */

import { describe, expect, it } from "vitest";

import { CompilerHarness } from "@agentick/compiler-react";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import {
  ErrorCode,
  SPEC_VERSION,
  WireRpcError,
  type CreateSessionInput,
  type ExecutionTarget,
  type SessionEntry,
  type SessionHarnessProtocol,
  type WireExtensionContext,
} from "@agentick/spec";

import { permissiveAuthorizer } from "../authorizers.js";
import { createDynamicCommandResolver } from "../dynamic-commands.js";
import { GatewayHarness } from "../harness.js";
import { sessionWireExtension } from "../wire/session-extension.js";
import { fakeWireCtx } from "./fake-wire-ctx.js";

const NULL_ROOT = null as unknown;

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

const send = sessionWireExtension.methods["session/send"]!;
const get = sessionWireExtension.methods["session/get"]!;
const dispatch = sessionWireExtension.methods["session/dispatch"]!;

interface SendAck {
  readonly executionId: string;
  readonly door: string;
}

/**
 * A gateway holding `appIds.length` apps over one substrate, recording every
 * door op the framework takes as `create:<id>` / `resume:<id>`.
 */
async function doorsRig(appIds: readonly string[] = ["solo"]) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("doors", journal, bus, inbox, {
    scripted: {
      result: {
        specVersion: SPEC_VERSION,
        output: [{ type: "text", text: "ok" }],
        stopReason: "end",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    },
  });
  await executor.ready;

  const doors: string[] = [];
  const gateway = new GatewayHarness({ journal, bus, inbox });
  await gateway.listen();
  for (const appId of appIds) {
    await gateway.createApp({
      appId,
      rootElement: NULL_ROOT,
      options: {
        compiler: new CompilerHarness(`r-${appId}`, journal, bus, inbox),
        modelExecutor: executor,
        target,
        journal,
        bus,
        inbox,
        hooks: {
          onBeforeAppCreateSession: (input: CreateSessionInput) => {
            doors.push(`create:${input.sessionId}`);
          },
          // Around-form: the resume OP runs on every app the walk asks, so only
          // the one that hands a session back actually opened a door.
          onAppResumeSession: async (
            input: { sessionId: string },
            next: (i: { sessionId: string }) => Promise<SessionHarnessProtocol | undefined>,
          ) => {
            const session = await next(input);
            if (session) doors.push(`resume:${input.sessionId}`);
            return session;
          },
        },
      },
    });
  }

  const app = (appId = appIds[0]!) => gateway.app(appId)!;
  /** A session that has run one real turn, then been paged out by the reaper. */
  const evicted = async (sessionId: string, appId = appIds[0]!) => {
    const s = await app(appId).createSession({ sessionId });
    await (
      await s.send({ messages: [{ role: "user", content: "first" }] })
    ).result;
    await app(appId).evictSession(sessionId);
    expect(app(appId).getSession(sessionId)).toBeUndefined();
    doors.length = 0;
    return s;
  };

  return { gateway, inbox, doors, app, evicted, ctx: fakeWireCtx(gateway) };
}

describe("session/send — the three doors", () => {
  it("a live session answers door 'live' and takes no door op", async () => {
    const { gateway, app, doors, ctx } = await doorsRig();
    await app().createSession({ sessionId: "live-1" });
    doors.length = 0;

    const ack = (await send(
      { sessionId: "live-1", messages: [{ role: "user", content: "hi" }] } as never,
      ctx,
    )) as SendAck;

    expect(ack.door).toBe("live");
    expect(doors).toEqual([]);
    await gateway.close();
  });

  it("an evicted session takes the RESUME door and answers door 'resumed'", async () => {
    const { gateway, evicted, doors, ctx } = await doorsRig();
    await evicted("cold-1");

    const ack = (await send(
      { sessionId: "cold-1", messages: [{ role: "user", content: "again" }] } as never,
      ctx,
    )) as SendAck;

    expect(ack.door).toBe("resumed");
    expect(doors).toContain("resume:cold-1");
    expect(doors).not.toContain("create:cold-1");
    await gateway.close();
  });

  it("a nonexistent id takes the CREATE door, answers 'created', and materializes the record", async () => {
    const { gateway, app, doors, ctx } = await doorsRig();
    // The draft flow: the client minted this id and never told the server about
    // it, so nothing durable exists until the first send.
    expect(await app().getSessionRecord("draft-1")).toBeUndefined();

    const ack = (await send(
      { sessionId: "draft-1", messages: [{ role: "user", content: "first words" }] } as never,
      ctx,
    )) as SendAck;

    expect(ack.door).toBe("created");
    expect(doors).toEqual(["create:draft-1"]);
    expect(await app().getSessionRecord("draft-1")).toMatchObject({ id: "draft-1" });
    await gateway.close();
  });

  it("creation by send stamps the caller's principal, exactly as app/create_session does", async () => {
    const { gateway, app, ctx } = await doorsRig();
    const alice = { ...ctx, principal: "alice" } as unknown as WireExtensionContext;

    await send(
      { sessionId: "owned-1", messages: [{ role: "user", content: "mine" }] } as never,
      alice,
    );

    expect(app().getSession("owned-1")?.principal).toBe("alice");
    expect(await app().getSessionRecord("owned-1")).toMatchObject({ principal: "alice" });
    await gateway.close();
  });

  it("a multi-app gateway refuses to GUESS which app hosts a created session", async () => {
    const { gateway, doors, ctx } = await doorsRig(["one", "two"]);

    const err = await send(
      { sessionId: "draft-2", messages: [{ role: "user", content: "hi" }] } as never,
      ctx,
    ).catch((e: unknown) => e);

    expect((err as Error).constructor.name).toBe("AppAmbiguousError");
    expect((err as { appIds: string[] }).appIds).toEqual(["one", "two"]);
    expect(doors).toEqual([]);
    await gateway.close();
  });

  it("`appId` names the host app on a multi-app gateway", async () => {
    const { gateway, app, ctx } = await doorsRig(["one", "two"]);

    const ack = (await send(
      { sessionId: "draft-3", appId: "two", messages: [{ role: "user", content: "hi" }] } as never,
      ctx,
    )) as SendAck;

    expect(ack.door).toBe("created");
    expect(app("two").getSession("draft-3")).toBeDefined();
    expect(app("one").getSession("draft-3")).toBeUndefined();
    await gateway.close();
  });
});

describe("session/dispatch — work on a session that does not exist is an error", () => {
  it("does not create; the id stays unknown", async () => {
    const { gateway, app, doors, ctx } = await doorsRig();

    const err = await dispatch(
      { sessionId: "ghost-1", tool: "noop", input: {} } as never,
      ctx,
    ).catch((e: unknown) => e);

    expect((err as Error).constructor.name).toBe("SessionNotFoundError");
    expect(doors).toEqual([]);
    expect(await app().getSessionRecord("ghost-1")).toBeUndefined();
    await gateway.close();
  });
});

describe("a session-addressed dynamic verb — the read resume door", () => {
  const history = (inbox: LocalInbox) =>
    createDynamicCommandResolver({ inbox, authorizer: permissiveAuthorizer() })(
      "timeline/history",
    )!;

  it("timeline/history on an evicted session takes the resume door and serves the page", async () => {
    const { gateway, inbox, evicted, doors, ctx } = await doorsRig();
    await evicted("cold-2");

    const page = (await history(inbox).handler({ sessionId: "cold-2", limit: 10 }, ctx)) as {
      entries: readonly unknown[];
    };

    expect(page.entries.length).toBeGreaterThan(0);
    expect(doors).toContain("resume:cold-2");
    await gateway.close();
  });

  it("timeline/history on a nonexistent session is MethodNotFound and creates NOTHING", async () => {
    const { gateway, inbox, app, doors, ctx } = await doorsRig();

    const err = await history(inbox)
      .handler({ sessionId: "ghost-2" }, ctx)
      .catch((e: unknown) => e);

    expect((err as WireRpcError).code).toBe(ErrorCode.MethodNotFound);
    expect(doors).toEqual([]);
    expect(app().getSession("ghost-2")).toBeUndefined();
    expect(await app().getSessionRecord("ghost-2")).toBeUndefined();
    await gateway.close();
  });
});

describe("session/get — the pure read", () => {
  it("serves the record for a live session, an evicted one, and null for an unknown id — mounting none of them", async () => {
    const { gateway, app, evicted, doors, ctx } = await doorsRig();
    await app().createSession({ sessionId: "seen-1", eager: true });
    await evicted("cold-3");

    const live = (await get({ sessionId: "seen-1" } as never, ctx)) as SessionEntry | null;
    const cold = (await get({ sessionId: "cold-3" } as never, ctx)) as SessionEntry | null;
    const missing = (await get({ sessionId: "ghost-3" } as never, ctx)) as SessionEntry | null;

    expect(live?.id).toBe("seen-1");
    expect(cold?.id).toBe("cold-3");
    expect(missing).toBeNull();
    // The whole point: a read costs no residency. The evicted session is still
    // evicted, the unknown id is still unknown, and no door op fired.
    expect(app().getSession("cold-3")).toBeUndefined();
    expect(app().getSession("ghost-3")).toBeUndefined();
    expect(await app().getSessionRecord("ghost-3")).toBeUndefined();
    expect(doors).toEqual([]);
    await gateway.close();
  });
});
