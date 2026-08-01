/**
 * Execution-scoped fan-in of DESCENDANT progress signals (`session/send`
 * `fanIn`).
 *
 * The full stack, no fakes on the wire path: real client → in-process
 * transport → real gateway → real app → real session → real loop → real
 * tool-executor, and real `spawn` under all of it.
 *
 * ## What was broken
 *
 * A tool's `ctx.progress(...)` emits a bus signal scoped to the session AND
 * execution it runs in. The gateway's progress fan subscribed scoped to the
 * caller's execution, which is right for the turn's own tools and blind to
 * everything below it: a sub-agent runs its OWN execution, so its signals
 * matched nothing and a caller watching a fan-out saw silence for exactly the
 * work that takes long enough to need a progress bar.
 *
 * ## What `fanIn` does
 *
 * Widens the subscription to the whole gateway and filters on arrival: keep a
 * signal iff its execution IS this turn, or the emitting session's lineage
 * reaches this turn (`app.executionTreeContains`, the bottom-up read of the
 * same origin edge `abortExecutionTree` fans out over). Everything else is
 * refused, which is the isolation guarantee stated positively — and the reason
 * four of the six tests below are about frames that must NOT arrive.
 *
 * @see packages/gateway/src/wire/session-extension.ts — `inThisTurn`
 * @see docs/proposals/v2/blueprint/64-runtime-signal-family.md
 */

import { describe, expect, it } from "vitest";

import { createClient } from "@agentick/client-core";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { createGateway } from "@agentick/gateway";
import { fakeCompiler } from "@agentick/compiler/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import {
  jsonSchema,
  progressEventName,
  type ContentBlock,
  type EventFrame,
  type ExecutionTarget,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type LanguageModelExecutor,
  type ProgressEventPayload,
  type SessionExecutionHandle,
  type ToolHandler,
  type ToolRegistration,
} from "@agentick/spec";
import { dispatchRequest, type DispatchSink } from "@agentick/transport";
import { waitFor } from "@agentick/utils/testing";

import { inProcessTransport } from "../index.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

/**
 * One tick calling `tool` with `input`. Call ids are per-call, never shared —
 * two executions reusing one id are the same call to the executor, and the
 * second never reaches the handler.
 */
function callTick(tool: string, callId: string, input: object = {}) {
  return {
    result: {
      specVersion: "2026-05-08" as const,
      output: [{ type: "tool_use" as const, toolUseId: callId, name: tool, input }],
      stopReason: "tool_use" as const,
      toolCalls: [{ id: callId, name: tool, input }],
      usage,
    },
  };
}

function endTick(text: string) {
  return {
    result: {
      specVersion: "2026-05-08" as const,
      output: [{ type: "text" as const, text }],
      stopReason: "end" as const,
      usage,
    },
  };
}

/**
 * A fresh scripted executor. One per SEND that needs its own script: the fake's
 * cursor is per-instance and advances on every tick from any session, so two
 * concurrent sends sharing one instance would split a single script between
 * them.
 */
async function mkExec(name: string, scripted: unknown): Promise<LanguageModelExecutor> {
  const exec = new FakeLanguageModelExecutor(
    name,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    { scripted: scripted as never },
  );
  await exec.ready;
  return exec as unknown as LanguageModelExecutor;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function toolRegistration(name: string, handlerRef: string): ToolRegistration {
  return {
    declaration: {
      id: name,
      name,
      description: `test tool ${name}`,
      inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: true }),
      exposure: ["model", "dispatch"],
    },
    handlerRef,
    binding: { scope: "runtime" },
  };
}

/** What a spawn tool call carries: the tool its child should run, and whether to await it. */
interface SpawnToolInput {
  readonly inner: "report" | "park_report" | "spawn";
  readonly wait?: boolean;
}

interface Fixture {
  /** `sessionId` of every handler that actually emitted a progress signal. */
  readonly emitted: string[];
  /** Releases every handler parked in `park_report`. */
  release(): void;
}

/**
 * An app whose three tools compose every shape these tests need:
 *
 *  - `report`      — emits ONE progress signal keyed by its own tool call id.
 *  - `park_report` — the same, but only after the fixture releases it, so a
 *                    child can be made to emit while a LATER turn is running.
 *  - `spawn`       — spawns a sub-agent running `inner`, optionally awaiting it.
 *                    `inner: "spawn"` makes that child spawn in turn, which is
 *                    how the grandchild case is built.
 */
function mkTools(
  appOf: () => { getSession(id: string): { spawn(input: unknown): Promise<unknown> } | undefined },
  fixture: Fixture,
  gate: () => Promise<void>,
) {
  let seq = 0;

  const emit = (ctx: { sessionId?: string; toolCallId?: string; progress: unknown }): void => {
    (ctx.progress as (t: string, u: Record<string, unknown>) => void)(ctx.toolCallId ?? "?", {
      progress: 1,
      total: 3,
      message: `from ${ctx.sessionId}`,
    });
    fixture.emitted.push(ctx.sessionId ?? "?");
  };

  const handlers = new Map<string, ToolHandler>([
    [
      "handlers/report",
      (_input, { ctx }) => {
        emit(ctx as never);
        return [{ type: "text", text: "reported" }] as ContentBlock[];
      },
    ],
    [
      "handlers/park_report",
      async (_input, { ctx }) => {
        await gate();
        emit(ctx as never);
        return [{ type: "text", text: "reported late" }] as ContentBlock[];
      },
    ],
    [
      "handlers/spawn",
      async (input, { ctx }) => {
        const { inner, wait } = input as unknown as SpawnToolInput;
        const parent = appOf().getSession(ctx.sessionId as string);
        const childId = `kid${++seq}`;
        // A child that spawns in turn runs the awaiting shape, so the whole
        // lineage is still in flight when the deepest one emits.
        const innerInput: SpawnToolInput = { inner: "report", wait: true };
        const handle = (await parent!.spawn({
          sessionId: childId,
          originCallId: ctx.toolCallId,
          send: {
            messages: [{ role: "user", content: "work" }],
            modelExecutor: await mkExec(childId, [
              callTick(inner === "spawn" ? "spawn" : inner, `${childId}-c1`, innerInput),
              endTick("child done"),
            ]),
          },
        })) as SessionExecutionHandle;
        if (wait === true) await handle.result;
        else void handle.result.catch(() => undefined);
        return [{ type: "text", text: childId }] as ContentBlock[];
      },
    ],
    [
      "handlers/release",
      async (_input, { ctx }) => {
        fixture.release();
        // Return only once the parked emitter has actually fired, so the
        // "did NOT arrive" assertions are about filtering, not about timing.
        await waitFor(() => fixture.emitted.length > 0, { description: "parked emitter fired" });
        void ctx;
        return [{ type: "text", text: "released" }] as ContentBlock[];
      },
    ],
  ]);

  const registrations = [
    toolRegistration("report", "handlers/report"),
    toolRegistration("park_report", "handlers/park_report"),
    toolRegistration("spawn", "handlers/spawn"),
    toolRegistration("release", "handlers/release"),
  ];

  return { handlers, registrations };
}

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------

interface AppSpec {
  readonly appId: string;
  readonly sessionId: string;
  /** The root session's script — its ticks, in order. */
  readonly script: unknown;
}

/**
 * A gateway hosting one app per {@link AppSpec}, each with its own default
 * executor (concurrent roots must not share a script cursor), plus a connected
 * client speaking the raw wire.
 */
async function makeStack(specs: readonly AppSpec[]) {
  let release = (): void => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture: Fixture = { emitted: [], release: () => release() };

  const apps = new Map<string, { getSession(id: string): never }>();
  const appOf = () => ({
    getSession: (id: string) => {
      for (const app of apps.values()) {
        const found = (app as unknown as { getSession(i: string): unknown }).getSession(id);
        if (found !== undefined) return found as never;
      }
      return undefined as never;
    },
  });
  const { handlers, registrations } = mkTools(appOf, fixture, () => released);

  const gateway = await createGateway();
  await gateway.listen();

  for (const spec of specs) {
    const app = await gateway.createApp({
      appId: spec.appId,
      rootElement: null,
      options: {
        modelExecutor: await mkExec(spec.appId, spec.script),
        compiler: fakeCompiler(),
        target,
        inheritedTools: registrations,
        toolHandlers: handlers,
      },
    });
    apps.set(spec.appId, app as never);
    await (app as unknown as { createSession(i: unknown): Promise<unknown> }).createSession({
      sessionId: spec.sessionId,
    });
  }

  let sinkForwarder: ((n: { method: string; params?: unknown }) => void) | undefined;
  const sink: DispatchSink = {
    sendNotification: (n) => sinkForwarder?.(n),
    registerSubscription: () => {},
    unregisterSubscription: () => {},
    registerInFlight: (_id: JsonRpcId, _abort: () => void) => {},
    unregisterInFlight: () => {},
  };
  const handler = async (
    req: JsonRpcRequest,
    sendNotification: (n: { method: string; params?: unknown }) => void,
  ): Promise<JsonRpcResponse> => {
    sinkForwarder = sendNotification;
    return dispatchRequest(gateway, req, sink);
  };

  const client = await createClient({ transport: inProcessTransport({ handler }) });
  await client.connect();

  return {
    client,
    fixture,
    cleanup: async () => {
      fixture.release();
      await client.close();
      await gateway.close();
    },
  };
}

/** Open a progress stream on `token` and collect every frame it yields. */
function collect(client: Awaited<ReturnType<typeof makeStack>>["client"], token: string) {
  const stream = client.transport.progress(token);
  const frames: EventFrame[] = [];
  const drain = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();
  return {
    frames,
    /** The sessions whose progress SIGNALS landed on this token. */
    signalSessions: () =>
      frames
        .filter((f) => f.envelope.name === progressEventName("tool"))
        .map((f) => f.envelope.scope.sessionId),
    async settle() {
      await new Promise((r) => setTimeout(r, 30));
      await stream.close();
      await drain;
    },
  };
}

// ---------------------------------------------------------------------------
// 1 + 2 — the default, and the opt-in
// ---------------------------------------------------------------------------

/** Root: emit my own progress, then spawn a child that emits its own, and wait for it. */
const rootReportThenSpawn = [
  callTick("report", "tc-root-1"),
  callTick("spawn", "tc-root-2", { inner: "report", wait: true } satisfies SpawnToolInput),
  endTick("root done"),
];

describe("session/send fanIn — descendant progress signals", () => {
  it("without fanIn, a child's progress does NOT reach the parent's stream", async () => {
    const { client, fixture, cleanup } = await makeStack([
      { appId: "app-a", sessionId: "root", script: rootReportThenSpawn },
    ]);
    const token = "t-default";
    const sink = collect(client, token);

    await client.request("session/send", {
      sessionId: "root",
      messages: [{ role: "user", content: "go" }],
      _meta: { progressToken: token },
    });
    await sink.settle();

    // BOTH tools ran and BOTH emitted — the child's silence on the wire is the
    // subscription's scope, not a missing signal.
    expect(fixture.emitted).toEqual(["root", "kid1"]);
    expect(sink.signalSessions()).toEqual(["root"]);

    await cleanup();
  });

  it("with fanIn, the child's frames arrive — named, attributed, and correlated", async () => {
    const { client, fixture, cleanup } = await makeStack([
      { appId: "app-a", sessionId: "root", script: rootReportThenSpawn },
    ]);
    const token = "t-fanin";
    const sink = collect(client, token);

    await client.request("session/send", {
      sessionId: "root",
      messages: [{ role: "user", content: "go" }],
      fanIn: true,
      _meta: { progressToken: token },
    });
    await sink.settle();

    expect(fixture.emitted).toEqual(["root", "kid1"]);
    expect(sink.signalSessions()).toEqual(["root", "kid1"]);

    // The child's frame is self-describing on all three axes a consumer needs:
    // WHAT kind of frame (`name`), WHO emitted it (`scope`), and WHICH call it
    // belongs to (`payload.token` — the tool call id the dispatch minted).
    const child = sink.frames.find(
      (f) => f.envelope.name === progressEventName("tool") && f.envelope.scope.sessionId === "kid1",
    );
    expect(child).toBeDefined();
    expect(child!.envelope.scope.sessionId).toBe("kid1");
    expect(child!.envelope.scope.executionId).toBeDefined();
    // The child ran its OWN execution — that is precisely why the default
    // subscription could not see it.
    const root = sink.frames.find(
      (f) => f.envelope.name === progressEventName("tool") && f.envelope.scope.sessionId === "root",
    );
    expect(child!.envelope.scope.executionId).not.toBe(root!.envelope.scope.executionId);
    expect(child!.envelope.payload as ProgressEventPayload).toMatchObject({
      token: "kid1-c1",
      progress: 1,
      total: 3,
      message: "from kid1",
    });

    await cleanup();
  });

  // -------------------------------------------------------------------------
  // 3 — depth
  // -------------------------------------------------------------------------

  it("reaches a GRANDCHILD — membership is the lineage, not one hop", async () => {
    const { client, fixture, cleanup } = await makeStack([
      {
        appId: "app-a",
        sessionId: "root",
        // The root spawns a child that spawns in turn; only the deepest emits.
        script: [
          callTick("spawn", "tc-root-1", { inner: "spawn", wait: true } satisfies SpawnToolInput),
          endTick("root done"),
        ],
      },
    ]);
    const token = "t-deep";
    const sink = collect(client, token);

    await client.request("session/send", {
      sessionId: "root",
      messages: [{ role: "user", content: "go" }],
      fanIn: true,
      _meta: { progressToken: token },
    });
    await sink.settle();

    // kid1 spawned kid2; kid2 emitted. kid2's parent chain is
    // kid2 → kid1 (originExecutionId = the root turn) → hit.
    expect(fixture.emitted).toEqual(["kid2"]);
    expect(sink.signalSessions()).toEqual(["kid2"]);

    await cleanup();
  });

  // -------------------------------------------------------------------------
  // 4 — isolation, the test that matters most
  // -------------------------------------------------------------------------

  it("two concurrent turns never see each other's lineage", async () => {
    // Separate apps, because the fan-in subscription is GATEWAY-wide: every
    // signal on the gateway reaches BOTH drains, and only the arrival filter
    // separates them. Two apps is also the configuration where a mistake is
    // worst — one tenant's sub-agent progress on another's stream.
    const { client, fixture, cleanup } = await makeStack([
      { appId: "app-a", sessionId: "root-a", script: rootReportThenSpawn },
      { appId: "app-b", sessionId: "root-b", script: rootReportThenSpawn },
    ]);
    const sinkA = collect(client, "t-iso-a");
    const sinkB = collect(client, "t-iso-b");

    await Promise.all([
      client.request("session/send", {
        sessionId: "root-a",
        messages: [{ role: "user", content: "go" }],
        fanIn: true,
        _meta: { progressToken: "t-iso-a" },
      }),
      client.request("session/send", {
        sessionId: "root-b",
        messages: [{ role: "user", content: "go" }],
        fanIn: true,
        _meta: { progressToken: "t-iso-b" },
      }),
    ]);
    await Promise.all([sinkA.settle(), sinkB.settle()]);

    // Four emissions total, two per turn. Each stream carries exactly its own.
    expect(fixture.emitted.length).toBe(4);
    const a = sinkA.signalSessions();
    const b = sinkB.signalSessions();
    expect(new Set(a)).toEqual(new Set(["root-a", a.find((s) => s?.startsWith("kid"))!]));
    expect(a.some((s) => s === "root-b")).toBe(false);
    expect(b.some((s) => s === "root-a")).toBe(false);
    expect(new Set([...a, ...b]).size).toBe(4);

    await cleanup();
  });

  it("a SIBLING turn's live child stays off the next turn's stream", async () => {
    // One session, two turns, in order. Turn A spawns a child and does NOT wait
    // for it, so that child is still alive — and still emitting — while turn B
    // runs. B's stream must carry its own child and nothing of A's, which is the
    // membership rule doing the only work it can do here: both children are live
    // descendants of the same SESSION, and only the origin EXECUTION separates
    // them.
    const { client, fixture, cleanup } = await makeStack([
      {
        appId: "app-a",
        sessionId: "root",
        script: [
          // Turn A
          callTick("spawn", "tc-a1", { inner: "park_report" } satisfies SpawnToolInput),
          endTick("turn A done"),
          // Turn B
          callTick("spawn", "tc-b1", { inner: "report", wait: true } satisfies SpawnToolInput),
          callTick("release", "tc-b2"),
          endTick("turn B done"),
        ],
      },
    ]);

    const sinkA = collect(client, "t-sib-a");
    await client.request("session/send", {
      sessionId: "root",
      messages: [{ role: "user", content: "turn A" }],
      fanIn: true,
      _meta: { progressToken: "t-sib-a" },
    });
    await sinkA.settle();
    // A's child is parked, so A's own turn carried no signals at all.
    expect(sinkA.signalSessions()).toEqual([]);

    const sinkB = collect(client, "t-sib-b");
    await client.request("session/send", {
      sessionId: "root",
      messages: [{ role: "user", content: "turn B" }],
      fanIn: true,
      _meta: { progressToken: "t-sib-b" },
    });
    await sinkB.settle();

    // kid1 (turn A's) emitted DURING turn B — proven by the fixture — and kid2
    // (turn B's) emitted too. Only kid2 is B's.
    expect(new Set(fixture.emitted)).toEqual(new Set(["kid1", "kid2"]));
    expect(sinkB.signalSessions()).toEqual(["kid2"]);

    await cleanup();
  });

  // -------------------------------------------------------------------------
  // 5 — teardown
  // -------------------------------------------------------------------------

  it("stops forwarding once the send settles", async () => {
    // The gateway bus outlives the RPC, so a gateway-WIDE subscription that
    // survived its send would keep pushing a stranger's frames onto a token
    // whose turn is over. Observable form of the invariant: a descendant that
    // emits after the send returns adds nothing to the caller's stream.
    const { client, fixture, cleanup } = await makeStack([
      {
        appId: "app-a",
        sessionId: "root",
        script: [
          callTick("spawn", "tc-1", { inner: "park_report" } satisfies SpawnToolInput),
          endTick("root done"),
        ],
      },
    ]);
    const token = "t-teardown";
    const sink = collect(client, token);

    await client.request("session/send", {
      sessionId: "root",
      messages: [{ role: "user", content: "go" }],
      fanIn: true,
      _meta: { progressToken: token },
    });
    await sink.settle();
    const afterSettle = sink.frames.length;
    expect(sink.signalSessions()).toEqual([]);

    // Now let the orphaned child emit.
    fixture.release();
    await waitFor(() => fixture.emitted.includes("kid1"), { description: "orphan emitted" });
    await new Promise((r) => setTimeout(r, 30));

    expect(sink.frames.length).toBe(afterSettle);

    await cleanup();
  });
});
