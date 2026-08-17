/**
 * Client-tool WRITE verb end-to-end (stage 2) — the DECLARATIVE whole-slice
 * replace (`session/set_client_tools`), over the REAL wire.
 *
 * No fakes on the wire path: real client → in-process transport → real gateway
 * → real app → real session → real tool-executor. We drive
 * `client.session(id).clientToolCalls.set(...)` and then read the session's live
 * `toolExecutor.compileForTick(...)` to prove the model-visible tool set
 * reflects the wire mutations — a client is a declarative tool SOURCE that owns
 * the `{ scope: "client", sessionId }` slice.
 *
 * Complements `client-tools.spec.ts` (which pins the client-verb → wire-method
 * ROUTING against a stub JSON-RPC handler) and the harness-level
 * `@agentick/tool-executor/__tests__/client-tools.spec.ts` (which pins the
 * suspend-resume dispatch path). Here we pin the GATEWAY handler behavior the
 * routing tests can't see: the whole-slice replace + the app-tools-not-clobbered
 * guarantee (the distinct `client` vs `session` binding).
 */

// ADR 87 — contributes `session.clientToolCalls` (the folded handle).
import "@agentick/tool-executor/client";
import { createTool, type Tool } from "@agentick/tool-executor/client";

import { describe, expect, it } from "vitest";

import { createClient } from "@agentick/client-core";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { createGateway } from "@agentick/gateway";
import { fakeCompiler } from "@agentick/compiler/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import {
  jsonSchema,
  toJsonSchema,
  type ClientToolDeclaration,
  type ContentBlock,
  type ExecutionTarget,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ToolDeclaration,
  type ToolExecutorProtocol,
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

const schema = (prop: string) =>
  ({ type: "object", properties: { [prop]: { type: "string" } }, required: [prop] }) as const;

const declA: ClientToolDeclaration = {
  name: "client_a",
  description: "tool A",
  inputSchema: schema("a"),
  annotations: { requiresResponse: true },
};
const declB: ClientToolDeclaration = {
  name: "client_b",
  description: "tool B",
  inputSchema: schema("b"),
  annotations: { requiresResponse: true },
};
const declC: ClientToolDeclaration = {
  name: "client_c",
  description: "tool C",
  inputSchema: schema("c"),
  annotations: { requiresResponse: true },
};

/** A server-handled app tool contributed via `createSession({ tools })`. */
const APP_SCHEMA = { type: "object", properties: { q: { type: "string" } } } as const;
const appTool: ToolDeclaration = {
  id: "app_tool",
  name: "app_tool",
  description: "an app-declared session tool",
  inputSchema: jsonSchema(APP_SCHEMA),
  exposure: ["model"],
};

type SessionWithTools = { readonly id: string; readonly toolExecutor: ToolExecutorProtocol };

async function makeStack(sessionTools?: readonly ToolDeclaration[]) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();

  // Present but never driven — no `session/send` in this suite.
  const executor = new FakeLanguageModelExecutor("ct-exec", journal, bus, inbox, { scripted: [] });
  await executor.ready;

  const gateway = await createGateway();
  await gateway.listen();
  const app = await gateway.createApp({
    appId: "ct-app",
    rootElement: null,
    options: { modelExecutor: executor, compiler: fakeCompiler(), target },
  });
  // The concrete session exposes `toolExecutor` at runtime (session/harness.ts);
  // `SessionHarnessProtocol` under-declares it, so narrow via `unknown` exactly
  // as the gateway's `sessionWireExtension` does at its call site.
  const session = (await app.createSession({
    sessionId: "ct-session",
    ...(sessionTools !== undefined ? { tools: sessionTools } : {}),
  })) as unknown as SessionWithTools;

  const sink: DispatchSink = {
    sendNotification: () => {},
    registerSubscription: () => {},
    unregisterSubscription: () => {},
    registerInFlight: (_id: JsonRpcId, _abort: () => void) => {},
    unregisterInFlight: () => {},
  };
  const handler = (req: JsonRpcRequest): Promise<JsonRpcResponse> =>
    dispatchRequest(gateway, req, sink);

  const client = await createClient({ transport: inProcessTransport({ handler }) });
  await client.connect();

  return {
    client,
    session,
    cleanup: async () => {
      await client.close();
      await gateway.close();
    },
  };
}

/** The model-visible tool names for the session. */
async function compiledNames(session: SessionWithTools): Promise<string[]> {
  const compiled = await session.toolExecutor.compileForTick({ exposure: "model" });
  return compiled.map((d) => d.name).sort();
}

/** The model-visible declaration(s) for `name`. */
async function compiledTool(session: SessionWithTools, name: string) {
  const compiled = await session.toolExecutor.compileForTick({ exposure: "model" });
  return compiled.filter((d) => d.name === name);
}

describe("client-tool wire verb — end-to-end (declarative slice-replace)", () => {
  it("set_client_tools UPSERTS by name: [A,B] then [B,C] ⇒ {A,B,C}", async () => {
    const { client, session, cleanup } = await makeStack();
    try {
      const sess = client.session(session.id);

      const ack1 = await sess.clientToolCalls.set([declA, declB]);
      expect(ack1).toEqual({ count: 2 });
      expect(await compiledNames(session)).toEqual(["client_a", "client_b"]);

      // A survives, because SEVERAL clients share this slice and a declaration
      // that omits a tool is not a claim that the tool is gone — it is a claim
      // about what THIS client can do. Whole-slice replace made the second
      // client to declare silently delete the first one's tools.
      const ack2 = await sess.clientToolCalls.set([declB, declC]);
      expect(ack2).toEqual({ count: 2 });
      expect(await compiledNames(session)).toEqual(["client_a", "client_b", "client_c"]);
    } finally {
      await cleanup();
    }
  });

  it("re-declaring a same-name tool with a changed shape swaps cleanly (no ToolAlreadyRegistered)", async () => {
    const { client, session, cleanup } = await makeStack();
    try {
      const sess = client.session(session.id);
      await sess.clientToolCalls.set([
        { name: "client_x", description: "v1", inputSchema: schema("a") },
      ]);
      // Same name, changed shape — the upsert replaces within the client slot,
      // so the collision guard does not fire and the latest declaration wins.
      await sess.clientToolCalls.set([
        { name: "client_x", description: "v2", inputSchema: schema("b") },
      ]);

      const xs = await compiledTool(session, "client_x");
      expect(xs).toHaveLength(1);
      expect(xs[0]!.description).toBe("v2");
      expect(toJsonSchema(xs[0]!.inputSchema)).toEqual(schema("b"));
    } finally {
      await cleanup();
    }
  });

  it("declaring the empty set changes nothing — it is not a claim about other clients", async () => {
    const { client, session, cleanup } = await makeStack();
    try {
      const sess = client.session(session.id);
      await sess.clientToolCalls.set([declA, declB]);
      expect(await compiledNames(session)).toEqual(["client_a", "client_b"]);

      // A client with nothing to offer says nothing about what its peers offer.
      // Clearing here would let any client wipe the session's whole tool set.
      // The slice is reaped at session close.
      const ack = await sess.clientToolCalls.set([]);
      expect(ack).toEqual({ count: 0 });
      expect(await compiledNames(session)).toEqual(["client_a", "client_b"]);
    } finally {
      await cleanup();
    }
  });

  it("does NOT clobber createSession({ tools }) app tools — client slice is distinct from session slice", async () => {
    const { client, session, cleanup } = await makeStack([appTool]);
    try {
      const sess = client.session(session.id);
      // The app's session-scoped tool is visible up front.
      expect(await compiledTool(session, "app_tool")).toHaveLength(1);

      await sess.clientToolCalls.set([declA, declB]);
      expect(await compiledNames(session)).toEqual(["app_tool", "client_a", "client_b"]);

      // The app's session-bound tool is in a different binding slot, so nothing
      // a client declares reaches it.
      await sess.clientToolCalls.set([declC]);
      expect(await compiledNames(session)).toEqual([
        "app_tool",
        "client_a",
        "client_b",
        "client_c",
      ]);
    } finally {
      await cleanup();
    }
  });
});

describe("two clients on one session", () => {
  it("a second client's declarations ADD to the first's — neither is erased", async () => {
    // The whole-slice replace this verb used to do meant the second client to
    // declare silently deleted the first's tools. The model stopped seeing
    // them, and the client that lost them had asked for nothing.
    const { client, session, cleanup } = await makeStack();

    await client.session("ct-session").clientToolCalls.set([declA]);
    await client.session("ct-session").clientToolCalls.set([declB]);

    expect(await compiledNames(session)).toEqual(["client_a", "client_b"]);
    await cleanup();
  });

  it("re-declaring the same name replaces it — latest wins, no collision error", async () => {
    const { client, session, cleanup } = await makeStack();

    await client.session("ct-session").clientToolCalls.set([declA]);
    const revised: ClientToolDeclaration = { ...declA, description: "tool A, revised" };
    await client.session("ct-session").clientToolCalls.set([revised]);

    const [compiled] = await compiledTool(session, "client_a");
    expect(compiled?.description).toBe("tool A, revised");
    await cleanup();
  });

  it("does NOT clobber the app's server-side tool of the same name", async () => {
    // Different binding slot: replacing within the client slice leaves the
    // app's `createSession({ tools })` registration alone.
    const collidingAppTool: ToolDeclaration = { ...appTool, id: "client_a", name: "client_a" };
    const { client, session, cleanup } = await makeStack([collidingAppTool]);

    await client.session("ct-session").clientToolCalls.set([declA]);

    expect((await compiledTool(session, "client_a")).length).toBeGreaterThan(0);
    await cleanup();
  });
});

/**
 * A client with SEVERAL threads open — the shape #303 is about. Handlers stay
 * bound for every session the client has open, so a call raised by the thread
 * the user is NOT looking at still reaches a handler, and it says which thread
 * asked. While that call is outstanding the session is `input_required`: the
 * execution is suspended on a human, and a thread list must be able to say so.
 */
describe("several sessions open on one client", () => {
  const navigateTo = (
    seen: { sessionId: string; to: unknown }[],
    gate: () => Promise<void>,
  ): Tool =>
    createTool({
      name: "navigate_to",
      description: "Take the user somewhere",
      inputSchema: jsonSchema<{ readonly to: string }>({
        type: "object",
        properties: { to: { type: "string" } },
        required: ["to"],
      }),
      handler: async (input, ctx) => {
        seen.push({ sessionId: ctx.sessionId, to: input.to });
        await gate();
        return "navigated";
      },
    });

  async function makeTwoSessionStack() {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    // One turn: call the client tool, then finish on the client's answer.
    const executor = new FakeLanguageModelExecutor("ct-multi-exec", journal, bus, inbox, {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [
              {
                type: "tool_use",
                toolUseId: "call-1",
                name: "navigate_to",
                input: { to: "/jobs" },
              },
            ],
            stopReason: "tool_use",
            toolCalls: [{ id: "call-1", name: "navigate_to", input: { to: "/jobs" } }],
          },
        },
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "done" } satisfies ContentBlock],
            stopReason: "end",
          },
        },
      ],
    });
    await executor.ready;

    const gateway = await createGateway();
    await gateway.listen();
    const app = await gateway.createApp({
      appId: "ct-multi-app",
      rootElement: null,
      options: { modelExecutor: executor, compiler: fakeCompiler(), target },
    });
    await app.createSession({ sessionId: "thread-a" });
    await app.createSession({ sessionId: "thread-b" });

    const client = await createClient({ transport: inProcessTransport({ gateway }) });
    await client.connect();
    return { client, cleanup: async () => (await client.close(), await gateway.close()) };
  }

  /** Let the gateway-side subscribe fiber land before anything publishes. */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

  it("returns ONE handle per session, so the tool-call fold is a singleton", async () => {
    const { client, cleanup } = await makeTwoSessionStack();
    try {
      // A second lookup used to build a second handle over the same session: a
      // second subscription, a second pending set, and whichever half of the
      // app held the other one never saw the call.
      // Compared as booleans: handing a session handle to `expect` makes it
      // enumerate, and enumerating materializes every lazy sub-handle getter.
      expect(client.session("thread-a") === client.session("thread-a")).toBe(true);
      expect(client.session("thread-a") === client.session("thread-b")).toBe(false);
      expect(
        client.session("thread-a").clientToolCalls === client.session("thread-a").clientToolCalls,
      ).toBe(true);

      // Closing releases the handle, so a session reopened under the same id is
      // not served the closed one.
      const first = client.session("thread-a");
      await first.close();
      expect(client.session("thread-a") === first).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("dispatches a call raised by the BACKGROUND session, and holds it at input_required", async () => {
    const { client, cleanup } = await makeTwoSessionStack();
    const seen: { sessionId: string; to: unknown }[] = [];
    let release!: () => void;
    const answered = new Promise<void>((r) => (release = r));

    try {
      // Both threads are open and both are bound — the user is looking at A.
      const a = client.session("thread-a");
      const b = client.session("thread-b");
      const tools = [navigateTo(seen, () => answered)];
      await a.clientToolCalls.use(tools);
      await b.clientToolCalls.use(tools);

      const frames: string[] = [];
      b.status.onChange((f) => frames.push(f.status));
      await settle();

      const turn = b.send({ messages: [{ role: "user", content: "take me there" }] });

      // The suspended call is a session state, not a private detail of the tab
      // that happens to hold the handler.
      await waitFor(() => b.status.get() === "input_required", {
        description: "the session to report it is waiting on the client",
        timeoutMs: 5_000,
      });
      expect(seen).toEqual([{ sessionId: "thread-b", to: "/jobs" }]);

      release();
      await turn.result;
      await waitFor(() => b.status.get() === "idle", {
        description: "the turn to end",
        timeoutMs: 5_000,
      });

      // The seed frame first (the subscription opens with the current status),
      // then the turn: suspended on the client, resumed by its answer, ended.
      expect(frames).toEqual(["idle", "running", "input_required", "running", "idle"]);
      // Nothing was asked of thread A, which never left idle.
      expect(client.session("thread-a").status.get() ?? "idle").toBe("idle");
    } finally {
      release();
      await cleanup();
    }
  });
});
