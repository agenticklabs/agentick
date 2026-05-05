/**
 * useOnEntry / useOnEvent — primitive timeline notification hook tests.
 *
 * Verifies:
 * - Handler fires for entries committed via session.append()
 * - Handler fires for entries committed via session.observe()
 * - Handler fires for messages committed during tick execution
 * - Filter (kind, role, type) narrows correctly
 * - Multiple handlers all fire
 * - useOnEvent sugar dispatches only event-role entries
 */

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { useOnEntry, useOnEvent } from "../entry-context.js";
import { createApp } from "../../app.js";
import { System } from "../../jsx/components/messages.js";
import { Model } from "../../jsx/components/primitives.js";
import { Timeline } from "../../jsx/components/timeline.js";
import { createTestAdapter } from "../../testing/index.js";

// ============================================================================
// useOnEntry
// ============================================================================

describe("useOnEntry", () => {
  it("fires when an entry is committed via session.append()", async () => {
    const handler = vi.fn();
    function Listener() {
      useOnEntry(handler);
      return null;
    }
    function Agent() {
      return (
        <>
          <Listener />
          <Model model={createTestAdapter({ defaultResponse: "ok" })} />
          <System>Test</System>
          <Timeline />
        </>
      );
    }
    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();
    await session.mount();

    expect(handler).not.toHaveBeenCalled();

    await session.append.exec({
      kind: "message",
      message: {
        role: "event",
        content: [{ type: "text", text: "hi" }],
        eventType: "test_event",
      } as any,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const [entry] = handler.mock.calls[0];
    expect(entry.kind).toBe("message");
    expect(entry.message.role).toBe("event");

    await session.close();
  });

  it("fires for messages committed during tick execution", async () => {
    const handler = vi.fn();
    function Listener() {
      useOnEntry(handler);
      return null;
    }
    function Agent() {
      return (
        <>
          <Listener />
          <Model model={createTestAdapter({ defaultResponse: "ack" })} />
          <System>T</System>
          <Timeline />
        </>
      );
    }
    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    await session.send({ messages: [{ role: "user", content: "hello" }] }).result;

    // Should fire at least for user input + assistant response
    expect(handler.mock.calls.length).toBeGreaterThanOrEqual(2);
    const roles = handler.mock.calls.map(([entry]) => entry.message?.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");

    await session.close();
  });

  it("filters by role", async () => {
    const eventsOnly = vi.fn();
    function Listener() {
      useOnEntry({ role: "event" }, eventsOnly);
      return null;
    }
    function Agent() {
      return (
        <>
          <Listener />
          <Model model={createTestAdapter({ defaultResponse: "ack" })} />
          <System>T</System>
          <Timeline />
        </>
      );
    }
    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();
    await session.mount();

    // Append an event — should fire
    await session.observe({ type: "x", content: "y" });
    expect(eventsOnly).toHaveBeenCalledTimes(1);

    // Send a user message → user + assistant entries committed; should NOT
    // fire because role !== "event"
    eventsOnly.mockClear();
    await session.send({ messages: [{ role: "user", content: "hi" }] }).result;
    expect(eventsOnly).not.toHaveBeenCalled();

    await session.close();
  });

  it("filters by event type", async () => {
    const fileOnly = vi.fn();
    function Listener() {
      useOnEntry({ role: "event", type: "file_opened" }, fileOnly);
      return null;
    }
    function Agent() {
      return (
        <>
          <Listener />
          <Model model={createTestAdapter({ defaultResponse: "ok" })} />
          <System>T</System>
          <Timeline />
        </>
      );
    }
    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();
    await session.mount();

    await session.observe({ type: "user_idle", content: "30s" });
    expect(fileOnly).not.toHaveBeenCalled();

    await session.observe({ type: "file_opened", content: "/foo" });
    expect(fileOnly).toHaveBeenCalledTimes(1);

    await session.close();
  });

  it("multiple handlers all fire", async () => {
    const a = vi.fn();
    const b = vi.fn();
    function ListenerA() {
      useOnEntry(a);
      return null;
    }
    function ListenerB() {
      useOnEntry(b);
      return null;
    }
    function Agent() {
      return (
        <>
          <ListenerA />
          <ListenerB />
          <Model model={createTestAdapter({ defaultResponse: "ok" })} />
          <System>T</System>
          <Timeline />
        </>
      );
    }
    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();
    await session.mount();

    await session.observe({ type: "x", content: "y" });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    await session.close();
  });
});

// ============================================================================
// useOnEvent (sugar)
// ============================================================================

describe("useOnEvent", () => {
  it("fires only for event-role entries (no type)", async () => {
    const events = vi.fn();
    function Listener() {
      useOnEvent(events);
      return null;
    }
    function Agent() {
      return (
        <>
          <Listener />
          <Model model={createTestAdapter({ defaultResponse: "ack" })} />
          <System>T</System>
          <Timeline />
        </>
      );
    }
    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();
    await session.mount();

    await session.observe({ type: "anything", content: "x" });
    expect(events).toHaveBeenCalledTimes(1);

    events.mockClear();
    await session.send({ messages: [{ role: "user", content: "hi" }] }).result;
    expect(events).not.toHaveBeenCalled(); // user/assistant aren't events

    await session.close();
  });

  it("filters by event type when type arg provided", async () => {
    const fileEvents = vi.fn();
    function Listener() {
      useOnEvent("file_opened", fileEvents);
      return null;
    }
    function Agent() {
      return (
        <>
          <Listener />
          <Model model={createTestAdapter({ defaultResponse: "ok" })} />
          <System>T</System>
          <Timeline />
        </>
      );
    }
    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();
    await session.mount();

    await session.observe({ type: "user_idle", content: "x" });
    expect(fileEvents).not.toHaveBeenCalled();

    await session.observe({ type: "file_opened", content: "/foo.ts" });
    expect(fileEvents).toHaveBeenCalledTimes(1);

    await session.close();
  });
});
