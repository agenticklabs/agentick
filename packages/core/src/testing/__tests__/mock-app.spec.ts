import { describe, it, expect } from "vitest";
import { createMockExecutionHandle, createMockSession, createMockApp } from "../mock-app";
import { ExecutionHandleBrand, isProcedure } from "@tentickle/kernel";

// ============================================================================
// createMockExecutionHandle
// ============================================================================

describe("createMockExecutionHandle", () => {
  it("resolves result with default response", async () => {
    const handle = createMockExecutionHandle();
    const result = await handle.result;
    expect(result.response).toBe("Mock response");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  });

  it("resolves result with custom response", async () => {
    const handle = createMockExecutionHandle({ response: "Custom!" });
    const result = await handle.result;
    expect(result.response).toBe("Custom!");
  });

  it("is branded as ExecutionHandle", () => {
    const handle = createMockExecutionHandle();
    expect(handle[ExecutionHandleBrand]).toBe(true);
  });

  it("emits content_delta events via async iteration", async () => {
    const handle = createMockExecutionHandle({ streamDeltas: ["Hello", " World"] });
    const events: any[] = [];
    for await (const event of handle) {
      events.push(event);
    }
    expect(events.filter((e) => e.type === "content_delta")).toHaveLength(2);
    expect(events[0].delta).toBe("Hello");
    expect(events[1].delta).toBe(" World");
    expect(events.at(-1).type).toBe("message_end");
  });

  it("emits tool call events", async () => {
    const handle = createMockExecutionHandle({
      toolCalls: [{ name: "search", input: { q: "test" }, result: { found: true } }],
    });
    const events: any[] = [];
    for await (const event of handle) {
      events.push(event);
    }
    const toolStart = events.find((e) => e.type === "tool_call_start");
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolStart).toBeDefined();
    expect(toolStart.name).toBe("search");
    expect(toolResult).toBeDefined();
    expect(toolResult.result).toEqual({ found: true });
  });

  it("rejects result on error", async () => {
    const handle = createMockExecutionHandle({ error: new Error("boom") });
    await expect(handle.result).rejects.toThrow("boom");
  });

  it("sets status to error on error", async () => {
    const handle = createMockExecutionHandle({ error: new Error("boom") });
    try {
      await handle.result;
    } catch {
      // expected
    }
    expect(handle.status).toBe("error");
  });

  it("tracks abort", () => {
    const handle = createMockExecutionHandle();
    expect(handle._aborted).toBe(false);
    handle.abort("user cancelled");
    expect(handle._aborted).toBe(true);
    expect(handle._abortReason).toBe("user cancelled");
    expect(handle.status).toBe("aborted");
  });

  it("tracks queued messages", () => {
    const handle = createMockExecutionHandle();
    handle.queueMessage({ role: "user", content: [{ type: "text", text: "follow up" }] });
    expect(handle._queuedMessages).toHaveLength(1);
    expect(handle._queuedMessages[0].role).toBe("user");
  });

  it("tracks tool results", () => {
    const handle = createMockExecutionHandle();
    handle.submitToolResult("tool-1", { approved: true });
    expect(handle._toolResults).toHaveLength(1);
    expect(handle._toolResults[0].toolUseId).toBe("tool-1");
  });

  it("applies delay before resolving", async () => {
    const start = Date.now();
    const handle = createMockExecutionHandle({ delay: 50 });
    await handle.result;
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  it("uses custom usage stats", async () => {
    const usage = { inputTokens: 100, outputTokens: 200, totalTokens: 300 };
    const handle = createMockExecutionHandle({ usage });
    const result = await handle.result;
    expect(result.usage).toEqual(usage);
  });

  it("has events EventBuffer with real API", async () => {
    const handle = createMockExecutionHandle({ response: "test" });
    // events is a real EventBuffer
    expect(handle.events).toBeDefined();
    expect(typeof handle.events.on).toBe("function");
    expect(typeof handle.events.close).toBe("function");
  });
});

// ============================================================================
// createMockSession
// ============================================================================

describe("createMockSession", () => {
  it("has default properties", () => {
    const session = createMockSession();
    expect(session.id).toBe("mock-session");
    expect(session.status).toBe("idle");
    expect(session.currentTick).toBe(0);
    expect(session.isAborted).toBe(false);
    expect(session.parent).toBeNull();
    expect(session.children).toEqual([]);
  });

  it("accepts custom id and status", () => {
    const session = createMockSession({ id: "test-1", status: "running" });
    expect(session.id).toBe("test-1");
    expect(session.status).toBe("running");
  });

  it("send returns a ProcedurePromise that resolves to a handle", async () => {
    const session = createMockSession({ executionOptions: { response: "Hello!" } });
    const handle = await session.send({ messages: [] });
    expect(handle.sessionId).toBe("mock-session");
    const result = await handle.result;
    expect(result.response).toBe("Hello!");
  });

  it("send.result chains through to SendResult", async () => {
    const session = createMockSession({ executionOptions: { response: "Chained!" } });
    const result = await session.send({ messages: [] }).result;
    expect(result.response).toBe("Chained!");
  });

  it("tracks send calls", async () => {
    const session = createMockSession();
    const input = {
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
    };
    await session.send(input);
    expect(session._sendCalls).toHaveLength(1);
    expect(session._sendCalls[0].input).toBe(input);
  });

  it("render returns handle and tracks calls", async () => {
    const session = createMockSession();
    const handle = await session.render({ query: "test" });
    expect(handle).toBeDefined();
    expect(session._renderCalls).toHaveLength(1);
    expect(session._renderCalls[0].props).toEqual({ query: "test" });
  });

  it("spawn returns handle and tracks calls", async () => {
    const session = createMockSession();
    const component = () => null as any;
    const handle = await session.spawn(component, { messages: [] });
    expect(handle).toBeDefined();
    expect(session._spawnCalls).toHaveLength(1);
    expect(session._spawnCalls[0].component).toBe(component);
  });

  it("queue tracks calls", async () => {
    const session = createMockSession();
    const msg = { role: "user" as const, content: [{ type: "text" as const, text: "queued" }] };
    await session.queue(msg);
    expect(session._queueCalls).toHaveLength(1);
    expect(session._queueCalls[0]).toBe(msg);
  });

  it("respondWith overrides next handle", async () => {
    const session = createMockSession({ executionOptions: { response: "Default" } });
    session.respondWith({ response: "Override!" });
    const result = await (await session.send({ messages: [] })).result;
    expect(result.response).toBe("Override!");

    // Next call uses defaults again
    const result2 = await (await session.send({ messages: [] })).result;
    expect(result2.response).toBe("Default");
  });

  it("_lastHandle tracks the most recent handle", async () => {
    const session = createMockSession();
    expect(session._lastHandle).toBeNull();
    await session.send({ messages: [] });
    expect(session._lastHandle).not.toBeNull();
  });

  it("close sets status to closed", () => {
    const session = createMockSession();
    expect(session.status).toBe("idle");
    session.close();
    expect(session.status).toBe("closed");
  });

  it("EventEmitter methods work", () => {
    const session = createMockSession();
    const events: string[] = [];
    session.on("test", (msg) => events.push(msg));
    session.emit("test", "hello");
    expect(events).toEqual(["hello"]);
  });

  it("procedures are branded with PROCEDURE_SYMBOL", () => {
    const session = createMockSession();
    expect(isProcedure(session.send)).toBe(true);
    expect(isProcedure(session.render)).toBe(true);
    expect(isProcedure(session.queue)).toBe(true);
    expect(isProcedure(session.spawn)).toBe(true);
  });

  it("channel returns a Channel instance", () => {
    const session = createMockSession();
    const ch = session.channel("test-channel");
    expect(ch).toBeDefined();
    expect(ch.name).toBe("test-channel");
    expect(typeof ch.publish).toBe("function");
    expect(typeof ch.subscribe).toBe("function");
  });

  it("snapshot returns valid structure", () => {
    const session = createMockSession({ id: "snap-test" });
    const snap = session.snapshot();
    expect(snap.sessionId).toBe("snap-test");
    expect(snap.timeline).toEqual([]);
  });

  it("inspect returns valid structure", () => {
    const session = createMockSession({ id: "inspect-test" });
    const info = session.inspect();
    expect(info.id).toBe("inspect-test");
    expect(info.status).toBe("idle");
  });
});

// ============================================================================
// createMockApp
// ============================================================================

describe("createMockApp", () => {
  it("creates and caches sessions", async () => {
    const app = createMockApp();
    const s1 = await app.session("test-1");
    const s2 = await app.session("test-1");
    expect(s1).toBe(s2);
    expect(app.has("test-1")).toBe(true);
    expect(app.sessions).toContain("test-1");
  });

  it("generates IDs for unnamed sessions", async () => {
    const app = createMockApp();
    const s1 = await app.session();
    const s2 = await app.session();
    expect(s1.id).not.toBe(s2.id);
  });

  it("run returns execution handle", async () => {
    const app = createMockApp({ executionOptions: { response: "Run result" } });
    const handle = await app.run({ messages: [] });
    const result = await handle.result;
    expect(result.response).toBe("Run result");
  });

  it("run is a procedure", () => {
    const app = createMockApp();
    expect(isProcedure(app.run)).toBe(true);
  });

  it("close removes session and tracks", async () => {
    const app = createMockApp();
    await app.session("to-close");
    expect(app.has("to-close")).toBe(true);
    await app.close("to-close");
    expect(app.has("to-close")).toBe(false);
    expect(app._closedSessions).toContain("to-close");
  });

  it("has returns false for unknown sessions", () => {
    const app = createMockApp();
    expect(app.has("nonexistent")).toBe(false);
  });

  it("hibernation methods return defaults", async () => {
    const app = createMockApp();
    expect(await app.isHibernated("test")).toBe(false);
    expect(await app.hibernate("test")).toBeNull();
    expect(await app.hibernatedSessions()).toEqual([]);
  });

  it("onSessionCreate fires when session is created", async () => {
    const app = createMockApp();
    const created: string[] = [];
    app.onSessionCreate((s) => created.push(s.id));
    await app.session("new-one");
    expect(created).toEqual(["new-one"]);

    // Existing session does not re-fire
    await app.session("new-one");
    expect(created).toEqual(["new-one"]);
  });

  it("onSessionClose fires when session is closed", async () => {
    const app = createMockApp();
    const closed: string[] = [];
    app.onSessionClose((id) => closed.push(id));
    await app.session("closing");
    await app.close("closing");
    expect(closed).toEqual(["closing"]);
  });

  it("unsubscribe works for lifecycle handlers", async () => {
    const app = createMockApp();
    const created: string[] = [];
    const unsub = app.onSessionCreate((s) => created.push(s.id));
    await app.session("first");
    expect(created).toEqual(["first"]);

    unsub();
    await app.session("second");
    expect(created).toEqual(["first"]); // no new entry
  });

  it("pre-created sessions are available", async () => {
    const existing = createMockSession({ id: "pre-existing" });
    const app = createMockApp({ sessions: { "pre-existing": existing } });
    expect(app.has("pre-existing")).toBe(true);
    const session = await app.session("pre-existing");
    expect(session).toBe(existing);
  });

  it("send delegates to session", async () => {
    const app = createMockApp({ executionOptions: { response: "Delegated" } });
    const handle = await app.send({ messages: [] }, { sessionId: "delegate-test" });
    const result = await handle.result;
    expect(result.response).toBe("Delegated");
    expect(app.has("delegate-test")).toBe(true);
  });

  it("_sessions map is accessible", () => {
    const app = createMockApp();
    expect(app._sessions).toBeInstanceOf(Map);
  });
});
