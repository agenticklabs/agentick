/**
 * Client wire hooks (ADR 83 §"Wire dispatch through the seam").
 *
 * Verifies the CLIENT-side twin of `harness.hook()`: `client.hook({...})`
 * and the `client.hooks` Proxy register `wire:`-prefixed before/after
 * hooks that fire on matching requests — before-hooks transform params
 * (or throw to abort) on the way out, after-hooks transform the result on
 * the way back. Uses a hand-rolled fake transport (mirrors
 * capabilities.spec.ts) so the suite isolates the hook plumbing from
 * execution semantics.
 */

import { describe, expect, it, vi } from "vitest";
import {
  type ClientState,
  type ClientTransport,
  type InitializeResult,
  type ProgressStream,
  type SessionSendParams,
  type SessionSendResult,
  type SubscriptionStream,
  type TransportCapabilities,
  type WireMethod,
  type WireParams,
  type WireResult,
} from "@agentick/spec-next";

import { createClient } from "../client.js";
import { commandForMethod } from "../hook-registry.js";

type Handler = <M extends WireMethod>(method: M, params: WireParams<M>) => Promise<WireResult<M>>;

/** Fake transport — hands `request` to a caller-supplied handler. */
function fakeTransport(handler: Handler): ClientTransport {
  let state: ClientState = "idle";
  const listeners = new Set<(s: ClientState) => void>();
  const notify = (s: ClientState) => {
    state = s;
    for (const l of listeners) l(s);
  };
  return {
    id: "fake",
    capabilities: {
      bidirectional: true,
      streamingRequest: true,
      reconnectable: false,
      binaryFrames: false,
    } satisfies TransportCapabilities,
    get state() {
      return state;
    },
    async connect() {
      notify("connecting");
      notify("open");
    },
    async close() {
      notify("closed");
    },
    request: handler as ClientTransport["request"],
    subscribe: (): SubscriptionStream => {
      throw new Error("subscribe not implemented in this fake");
    },
    progress: (): ProgressStream => {
      throw new Error("progress not implemented in this fake");
    },
    onStateChange(h) {
      listeners.add(h);
      return () => listeners.delete(h);
    },
  };
}

function initResult(): InitializeResult {
  return {
    protocolVersion: "v1",
    capabilities: {},
    serverInfo: { name: "@test/gateway", version: "0.0.0" },
    connectionId: "conn-1",
  };
}

function sendResult(overrides?: Partial<SessionSendResult>): SessionSendResult {
  return {
    executionId: "exec-1",
    finalCursor: { value: 1 },
    result: {
      response: "ok",
      output: [],
      toolResults: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      stopReason: "end",
      ticks: 1,
      executionId: "exec-1",
    },
    ...overrides,
  };
}

/**
 * Build a client whose transport records the params each method saw, and
 * answers handshake + `session/send` + `session/abort` with canned
 * results. Returns the client plus the recorded-params map.
 */
async function makeClient() {
  const seen = new Map<string, unknown>();
  const transport = fakeTransport(async (method, params) => {
    seen.set(method, params);
    if (method === "initialize") return initResult() as never;
    if (method === "_extensions/list") return { extensions: [] } as never;
    if (method === "session/send") return sendResult() as never;
    if (method === "session/abort") return null as never;
    throw new Error(`unexpected method: ${method}`);
  });
  const client = await createClient({ transport });
  await client.connect();
  return { client, seen };
}

const SEND_PARAMS: SessionSendParams = {
  sessionId: "s1",
  messages: [{ role: "user", content: "hi" }],
};

describe("client wire hooks", () => {
  it("derives WireSessionSend (not SessionSend) for session/send", () => {
    // The `wire:` prefix is the whole point — this command key must NOT
    // collide with the server-side `session:send` op hook.
    expect(commandForMethod("session/send")).toBe("WireSessionSend");
    // Snake_case segments split too (the derivation splits on `-:/_`, all four
    // word boundaries), so the snake_case wire id `app/run_once` mints the clean
    // camelCase `WireAppRunOnce` — `Pascal` and `deriveHookNames` agree, so the
    // type-level `WireHooks` key and the runtime command key match.
    expect(commandForMethod("app/run_once")).toBe("WireAppRunOnce");
  });

  it("onBeforeWireSessionSend transforms params reaching the transport", async () => {
    const { client, seen } = await makeClient();

    client.hook({
      onBeforeWireSessionSend: (params) => ({
        ...params,
        metadata: { tagged: true },
      }),
    });

    await client.request("session/send", SEND_PARAMS);

    expect(seen.get("session/send")).toMatchObject({
      sessionId: "s1",
      metadata: { tagged: true },
    });
  });

  it("passes the method + signal on the hook context", async () => {
    const { client } = await makeClient();
    const controller = new AbortController();
    const ctxSeen: unknown[] = [];

    client.hook({
      onBeforeWireSessionSend: (_params, ctx) => {
        ctxSeen.push(ctx);
      },
    });

    await client.request("session/send", SEND_PARAMS, controller.signal);
    expect(ctxSeen).toEqual([{ method: "session/send", signal: controller.signal }]);
  });

  it("a thrown before-hook aborts the request (transport never called)", async () => {
    const { client, seen } = await makeClient();
    seen.delete("session/send");

    client.hook({
      onBeforeWireSessionSend: () => {
        throw new Error("vetoed by hook");
      },
    });

    await expect(client.request("session/send", SEND_PARAMS)).rejects.toThrow("vetoed by hook");
    // The before-hook threw before the composed pipeline ran.
    expect(seen.has("session/send")).toBe(false);
  });

  it("onAfterWireSessionSend transforms the result the caller sees", async () => {
    const { client } = await makeClient();

    client.hook({
      onAfterWireSessionSend: (result) => ({
        ...result,
        executionId: "rewritten",
      }),
    });

    const result = await client.request("session/send", SEND_PARAMS);
    expect(result.executionId).toBe("rewritten");
  });

  it("is method-scoped — a session/send hook does NOT fire for session/abort", async () => {
    const { client } = await makeClient();
    const beforeSend = vi.fn((p: SessionSendParams) => p);

    client.hook({ onBeforeWireSessionSend: beforeSend });

    await client.request("session/abort", { sessionId: "s1" });
    expect(beforeSend).not.toHaveBeenCalled();

    await client.request("session/send", SEND_PARAMS);
    expect(beforeSend).toHaveBeenCalledTimes(1);
  });

  it("client.hooks proxy registers a single hook; unsubscribe removes it", async () => {
    const { client, seen } = await makeClient();

    const off = client.hooks.onBeforeWireSessionSend((params) => ({
      ...params,
      metadata: { viaProxy: true },
    }));

    await client.request("session/send", SEND_PARAMS);
    expect(seen.get("session/send")).toMatchObject({ metadata: { viaProxy: true } });

    off();
    await client.request("session/send", { sessionId: "s2" });
    // After unsubscribe the hook no longer transforms — no metadata added.
    expect(seen.get("session/send")).toEqual({ sessionId: "s2" });
  });

  it("client.hook batch unsubscribe removes every hook in the config", async () => {
    const { client } = await makeClient();
    const before = vi.fn((p: SessionSendParams) => p);
    const after = vi.fn((r: SessionSendResult) => r);

    const off = client.hook({
      onBeforeWireSessionSend: before,
      onAfterWireSessionSend: after,
    });

    await client.request("session/send", SEND_PARAMS);
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);

    off();
    await client.request("session/send", SEND_PARAMS);
    // No further calls after the composite unsubscribe.
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("empty registry fast-path leaves normal requests untouched", async () => {
    const { client, seen } = await makeClient();
    const result = await client.request("session/send", SEND_PARAMS);
    expect(result.executionId).toBe("exec-1");
    expect(seen.get("session/send")).toEqual(SEND_PARAMS);
  });
});
