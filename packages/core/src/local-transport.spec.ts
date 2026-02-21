import { describe, it, expect } from "vitest";
import { createLocalTransport } from "./local-transport.js";
import { createMockApp } from "./testing/mock-app.js";

describe("createLocalTransport", () => {
  it("starts disconnected", () => {
    const app = createMockApp();
    const transport = createLocalTransport(app);
    expect(transport.state).toBe("disconnected");
    expect(transport.connectionId).toBe("local");
  });

  it("connect() transitions to connected", async () => {
    const app = createMockApp();
    const transport = createLocalTransport(app);

    const states: string[] = [];
    transport.onStateChange((s) => states.push(s));

    await transport.connect();

    expect(transport.state).toBe("connected");
    expect(states).toEqual(["connected"]);
  });

  it("disconnect() transitions to disconnected", async () => {
    const app = createMockApp();
    const transport = createLocalTransport(app);

    await transport.connect();
    const states: string[] = [];
    transport.onStateChange((s) => states.push(s));

    transport.disconnect();

    expect(transport.state).toBe("disconnected");
    expect(states).toEqual(["disconnected"]);
  });

  it("onStateChange returns cleanup function", async () => {
    const app = createMockApp();
    const transport = createLocalTransport(app);

    const states: string[] = [];
    const cleanup = transport.onStateChange((s) => states.push(s));

    await transport.connect();
    expect(states).toEqual(["connected"]);

    cleanup();
    transport.disconnect();
    // Should NOT receive disconnected since we cleaned up
    expect(states).toEqual(["connected"]);
  });

  it("send() yields events from the execution handle", async () => {
    const app = createMockApp({
      executionOptions: { streamDeltas: ["Hello", " World"] },
    });
    const transport = createLocalTransport(app);
    await transport.connect();

    const stream = transport.send(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      "test-session",
    );

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    // Should have content_delta events + message_end, all with sessionId
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.sessionId === "test-session")).toBe(true);

    const deltas = events.filter((e) => e.type === "content_delta");
    expect(deltas).toHaveLength(2);
    expect(deltas[0].delta).toBe("Hello");
    expect(deltas[1].delta).toBe(" World");
  });

  it("send() defaults sessionId to main", async () => {
    const app = createMockApp();
    const transport = createLocalTransport(app);
    await transport.connect();

    const stream = transport.send({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.every((e) => e.sessionId === "main")).toBe(true);
  });

  it("send() does not double-dispatch to onEvent handlers", async () => {
    const app = createMockApp({
      executionOptions: { streamDeltas: ["Hello"] },
    });
    const transport = createLocalTransport(app);
    await transport.connect();

    const onEventCalls: any[] = [];
    transport.onEvent((event) => onEventCalls.push(event));

    const stream = transport.send(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      "test",
    );

    for await (const _event of stream) {
      // consume
    }

    // onEvent should NOT receive events from send() —
    // the client dispatches those from the async iterable
    expect(onEventCalls).toHaveLength(0);
  });

  it("abort() before generator starts aborts the handle", async () => {
    const app = createMockApp({
      executionOptions: { delay: 50, streamDeltas: ["Hello"] },
    });
    const transport = createLocalTransport(app);
    await transport.connect();

    const stream = transport.send(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      "test",
    );

    // Abort immediately before the generator body runs
    stream.abort("cancelled");

    const events: any[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    // Should get no events since we aborted before iteration started
    expect(events).toHaveLength(0);
  });

  it("onEvent returns cleanup function", async () => {
    const app = createMockApp();
    const transport = createLocalTransport(app);

    const events: any[] = [];
    const cleanup = transport.onEvent((e) => events.push(e));

    cleanup();
    // After cleanup, no events should be received
    expect(events).toHaveLength(0);
  });

  it("closeSession delegates to app.close", async () => {
    const app = createMockApp();
    const transport = createLocalTransport(app);
    await transport.connect();

    // Create session first
    await app.session("test");
    expect(app.has("test")).toBe(true);

    await transport.closeSession("test");
    expect(app._closedSessions).toContain("test");
  });

  it("subscribeToSession is a no-op", async () => {
    const app = createMockApp();
    const transport = createLocalTransport(app);
    await transport.connect();

    // Should not throw
    await transport.subscribeToSession("test");
    await transport.unsubscribeFromSession("test");
  });
});
