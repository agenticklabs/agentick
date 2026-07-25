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
  type ExecutionTarget,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ToolDeclaration,
  type ToolExecutorProtocol,
} from "@agentick/spec";
import { dispatchRequest, type DispatchSink } from "@agentick/transport";

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
  it("set_client_tools REPLACES the client slice wholesale: [A,B] then [B,C] ⇒ exactly {B,C}", async () => {
    const { client, session, cleanup } = await makeStack();
    try {
      const sess = client.session(session.id);

      const ack1 = await sess.clientToolCalls.set([declA, declB]);
      expect(ack1).toEqual({ count: 2 });
      expect(await compiledNames(session)).toEqual(["client_a", "client_b"]);

      // Re-declare a DIFFERENT set — A is gone (absent from the new set), C is
      // added, B persists. This is a whole-slice replace, not an accumulate.
      const ack2 = await sess.clientToolCalls.set([declB, declC]);
      expect(ack2).toEqual({ count: 2 });
      expect(await compiledNames(session)).toEqual(["client_b", "client_c"]);
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
      // Same name, changed schema — the slice clear-then-reinstall means no
      // collision guard fires.
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

  it("declaring the empty set clears the client slice", async () => {
    const { client, session, cleanup } = await makeStack();
    try {
      const sess = client.session(session.id);
      await sess.clientToolCalls.set([declA, declB]);
      expect(await compiledNames(session)).toEqual(["client_a", "client_b"]);

      const ack = await sess.clientToolCalls.set([]);
      expect(ack).toEqual({ count: 0 });
      expect(await compiledNames(session)).toEqual([]);
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

      // Declare a client set, then replace it with a different one.
      await sess.clientToolCalls.set([declA, declB]);
      expect(await compiledNames(session)).toEqual(["app_tool", "client_a", "client_b"]);

      await sess.clientToolCalls.set([declC]);
      // The client slice was replaced ({A,B} → {C}), but the app's session-bound
      // tool SURVIVES both replaces — proving `{ scope: "client" }` and
      // `{ scope: "session" }` are distinct slices.
      expect(await compiledNames(session)).toEqual(["app_tool", "client_c"]);

      // And clearing the client slice leaves the app tool standing.
      await sess.clientToolCalls.set([]);
      expect(await compiledNames(session)).toEqual(["app_tool"]);
    } finally {
      await cleanup();
    }
  });
});
