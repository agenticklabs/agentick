/**
 * `openSession` semantics on the wire (docs/proposals/v2/session-doors.md
 * slice 1), pinned against the real gateway → app → session stack rather than
 * a stubbed inbox: eviction has to genuinely unmount the surface for the
 * resume path to be under test.
 *
 * The law each test enforces: the client speaks existence and interaction
 * verbs; create and resume run because a verb required them. `session/send`
 * opens with `create` (it never 404s), reads never create, and `session/get`
 * never mounts anything at all.
 */

import { describe, expect, it } from "vitest";

import { CompilerHarness } from "@agentick/compiler-react";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import {
  SessionNotFoundError,
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
  readonly created: boolean;
}

/**
 * A gateway holding `appIds.length` apps over one substrate, recording every
 * lifecycle op the framework runs as `create:<id>` / `resume:<id>`.
 */
async function gatewayRig(appIds: readonly string[] = ["solo"]) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("open", journal, bus, inbox, {
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

  const ops: string[] = [];
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
            ops.push(`create:${input.sessionId}`);
          },
          // Around-form: the resume OP runs on every app the walk asks, so only
          // the one that hands a session back actually resumed.
          onAppResumeSession: async (
            input: { sessionId: string },
            next: (i: { sessionId: string }) => Promise<SessionHarnessProtocol | undefined>,
          ) => {
            const session = await next(input);
            if (session) ops.push(`resume:${input.sessionId}`);
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
    ops.length = 0;
    return s;
  };

  return { gateway, inbox, ops, app, evicted, ctx: fakeWireCtx(gateway) };
}

describe("session/send — open with create", () => {
  it("a live session opens with created:false and runs no lifecycle op", async () => {
    const { gateway, app, ops, ctx } = await gatewayRig();
    await app().createSession({ sessionId: "live-1" });
    ops.length = 0;

    const ack = (await send(
      { sessionId: "live-1", messages: [{ role: "user", content: "hi" }] } as never,
      ctx,
    )) as SendAck;

    expect(ack.created).toBe(false);
    expect(ops).toEqual([]);
    await gateway.close();
  });

  it("an evicted session is resumed, not created — created:false, resume op observed", async () => {
    const { gateway, evicted, ops, ctx } = await gatewayRig();
    await evicted("cold-1");

    const ack = (await send(
      { sessionId: "cold-1", messages: [{ role: "user", content: "again" }] } as never,
      ctx,
    )) as SendAck;

    expect(ack.created).toBe(false);
    expect(ops).toContain("resume:cold-1");
    expect(ops).not.toContain("create:cold-1");
    await gateway.close();
  });

  it("a nonexistent id is created — created:true, record materialized", async () => {
    const { gateway, app, ops, ctx } = await gatewayRig();
    // The draft flow: the client minted this id and never told the server about
    // it, so nothing durable exists until the first send.
    expect(await app().getSessionRecord("draft-1")).toBeUndefined();

    const ack = (await send(
      { sessionId: "draft-1", messages: [{ role: "user", content: "first words" }] } as never,
      ctx,
    )) as SendAck;

    expect(ack.created).toBe(true);
    expect(ops).toEqual(["create:draft-1"]);
    expect(await app().getSessionRecord("draft-1")).toMatchObject({ id: "draft-1" });
    await gateway.close();
  });

  it("creation by send stamps the caller's principal, exactly as app/create_session does", async () => {
    const { gateway, app, ctx } = await gatewayRig();
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
    const { gateway, ops, ctx } = await gatewayRig(["one", "two"]);

    const err = await send(
      { sessionId: "draft-2", messages: [{ role: "user", content: "hi" }] } as never,
      ctx,
    ).catch((e: unknown) => e);

    expect((err as Error).constructor.name).toBe("AppAmbiguousError");
    expect((err as { appIds: string[] }).appIds).toEqual(["one", "two"]);
    expect(ops).toEqual([]);
    await gateway.close();
  });

  it("`appId` names the host app on a multi-app gateway", async () => {
    const { gateway, app, ctx } = await gatewayRig(["one", "two"]);

    const ack = (await send(
      { sessionId: "draft-3", appId: "two", messages: [{ role: "user", content: "hi" }] } as never,
      ctx,
    )) as SendAck;

    expect(ack.created).toBe(true);
    expect(app("two").getSession("draft-3")).toBeDefined();
    expect(app("one").getSession("draft-3")).toBeUndefined();
    await gateway.close();
  });
});

describe("session/dispatch — work on a session that does not exist is an error", () => {
  it("does not create; the id stays unknown", async () => {
    const { gateway, app, ops, ctx } = await gatewayRig();

    const err = await dispatch(
      { sessionId: "ghost-1", tool: "noop", input: {} } as never,
      ctx,
    ).catch((e: unknown) => e);

    expect((err as Error).constructor.name).toBe("SessionNotFoundError");
    expect(ops).toEqual([]);
    expect(await app().getSessionRecord("ghost-1")).toBeUndefined();
    await gateway.close();
  });
});

describe("a session-addressed dynamic verb — reads resume, never create", () => {
  const history = (inbox: LocalInbox) =>
    createDynamicCommandResolver({ inbox, authorizer: permissiveAuthorizer() })(
      "timeline/history",
    )!;

  it("timeline/history on an evicted session resumes it and serves the page", async () => {
    const { gateway, inbox, evicted, ops, ctx } = await gatewayRig();
    await evicted("cold-2");

    const page = (await history(inbox).handler({ sessionId: "cold-2", limit: 10 }, ctx)) as {
      entries: readonly unknown[];
    };

    expect(page.entries.length).toBeGreaterThan(0);
    expect(ops).toContain("resume:cold-2");
    await gateway.close();
  });

  it("timeline/history on a nonexistent session is MethodNotFound and creates NOTHING", async () => {
    const { gateway, inbox, app, ops, ctx } = await gatewayRig();

    const err = await history(inbox)
      .handler({ sessionId: "ghost-2" }, ctx)
      .catch((e: unknown) => e);

    expect((err as WireRpcError).code).toBe(ErrorCode.MethodNotFound);
    expect(ops).toEqual([]);
    expect(app().getSession("ghost-2")).toBeUndefined();
    expect(await app().getSessionRecord("ghost-2")).toBeUndefined();
    await gateway.close();
  });
});

describe("session/get — the pure read", () => {
  it("serves the record for a live session, an evicted one, and null for an unknown id — mounting none of them", async () => {
    const { gateway, app, evicted, ops, ctx } = await gatewayRig();
    await app().createSession({ sessionId: "seen-1", eager: true });
    await evicted("cold-3");

    const live = (await get({ sessionId: "seen-1" } as never, ctx)) as SessionEntry | null;
    const cold = (await get({ sessionId: "cold-3" } as never, ctx)) as SessionEntry | null;
    const missing = (await get({ sessionId: "ghost-3" } as never, ctx)) as SessionEntry | null;

    expect(live?.id).toBe("seen-1");
    expect(cold?.id).toBe("cold-3");
    expect(missing).toBeNull();
    // The whole point: a read costs no residency. The evicted session is still
    // evicted, the unknown id is still unknown, and no lifecycle op ran.
    expect(app().getSession("cold-3")).toBeUndefined();
    expect(app().getSession("ghost-3")).toBeUndefined();
    expect(await app().getSessionRecord("ghost-3")).toBeUndefined();
    expect(ops).toEqual([]);
    await gateway.close();
  });
});

describe("session/set_client_tools — open WITHOUT create", () => {
  const setClientTools = sessionWireExtension.methods["session/set_client_tools"]!;

  it("remounts a hibernated session and installs the client slice on it", async () => {
    // The reopen-after-restart case: the browser declares its tools on a thread
    // no app holds live. Live-only resolution failed here, and the send that
    // followed remounted the session with an EMPTY client slice.
    const { app, ops, evicted, ctx } = await gatewayRig();
    await evicted("paged-out");

    const result = await setClientTools(
      {
        sessionId: "paged-out",
        declarations: [{ name: "navigate_to", description: "go", inputSchema: { type: "object" } }],
      } as never,
      ctx,
    );

    expect(result).toEqual({ count: 1 });
    expect(ops).toEqual(["resume:paged-out"]);
    const live = app().getSession("paged-out") as unknown as {
      toolExecutor: { tools: { list(): readonly { name: string; binding?: unknown }[] } };
    };
    expect(live).toBeDefined();
    expect(live.toolExecutor.tools.list().find((t) => t.name === "navigate_to")?.binding).toEqual({
      scope: "client",
      sessionId: "paged-out",
    });
  });

  it("a total miss still throws — declaring never creates", async () => {
    const { ctx } = await gatewayRig();
    await expect(
      setClientTools({ sessionId: "never-existed", declarations: [] } as never, ctx),
    ).rejects.toThrow(SessionNotFoundError);
  });
});
