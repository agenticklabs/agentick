/**
 * session.append() and session.observe() — primitive timeline writes.
 *
 * append: Direct write into the timeline, optionally triggers a tick.
 *   Different from queue, which routes through the next-tick inbox.
 *
 * observe: Sugar over append for event-role messages (eventType + content).
 *
 * Adversarial: append without trigger doesn't run model; trigger:true does;
 * append assigns id when missing; observe builds an EventMessage; entry
 * shows up in subsequent compile (model sees it).
 */

import { describe, it, expect } from "vitest";
import React from "react";
import { createApp } from "../../app.js";
import { System } from "../../jsx/components/messages.js";
import { Model } from "../../jsx/components/primitives.js";
import { Timeline } from "../../jsx/components/timeline.js";
import { createTestAdapter } from "../../testing/index.js";

function Agent() {
  return (
    <>
      <Model model={createTestAdapter({ defaultResponse: "ok" })} />
      <System>Test agent</System>
      <Timeline />
    </>
  );
}

// ============================================================================
// append() — primitive
// ============================================================================

describe("session.append()", () => {
  it("writes an entry directly to the timeline without triggering a tick", async () => {
    const model = createTestAdapter({ defaultResponse: "ok" });
    function A() {
      return (
        <>
          <Model model={model} />
          <System>T</System>
          <Timeline />
        </>
      );
    }
    const app = createApp(A, { maxTicks: 1 });
    const session = await app.session();

    await session.append({
      kind: "message",
      message: {
        role: "event",
        content: [{ type: "text", text: "hello world" }],
        eventType: "test_event",
      } as any,
    });

    // Model should NOT have been called
    expect(model.getCapturedInputs()).toHaveLength(0);

    // Entry should be in timeline
    const snapshot = session.snapshot();
    expect(snapshot.timeline.length).toBe(1);
    expect(snapshot.timeline[0]?.kind).toBe("message");
    expect((snapshot.timeline[0] as any).message.role).toBe("event");

    await session.close();
  });

  it("auto-assigns an id when missing", async () => {
    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    await session.append({
      kind: "message",
      message: {
        role: "event",
        content: [{ type: "text", text: "x" }],
      } as any,
    });

    const snapshot = session.snapshot();
    expect(snapshot.timeline[0]?.id).toBeDefined();
    expect(typeof snapshot.timeline[0]?.id).toBe("string");

    await session.close();
  });

  it("preserves an explicit id when provided", async () => {
    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    await session.append({
      id: "custom-id-123",
      kind: "message",
      message: {
        role: "event",
        content: [{ type: "text", text: "x" }],
      } as any,
    });

    const snapshot = session.snapshot();
    expect(snapshot.timeline[0]?.id).toBe("custom-id-123");

    await session.close();
  });

  it("emits entry_committed event on the session", async () => {
    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    const events: any[] = [];
    session.on("event", (e) => events.push(e));

    await session.append({
      kind: "message",
      message: {
        role: "event",
        content: [{ type: "text", text: "x" }],
      } as any,
    });

    const committed = events.find((e) => e.type === "entry_committed");
    expect(committed).toBeDefined();
    expect(committed.timelineIndex).toBe(0);

    await session.close();
  });

  it("with trigger:true runs a tick and returns a handle", async () => {
    const model = createTestAdapter({ defaultResponse: "ack" });
    function A() {
      return (
        <>
          <Model model={model} />
          <System>T</System>
          <Timeline />
        </>
      );
    }
    const app = createApp(A, { maxTicks: 1 });
    const session = await app.session();

    const handle = await session.append(
      {
        kind: "message",
        message: {
          role: "event",
          content: [{ type: "text", text: "trigger me" }],
        } as any,
      },
      { trigger: true },
    );

    expect(handle).toBeDefined();
    expect(handle).toHaveProperty("result");

    const result = await (handle as any).result;
    expect(result.response).toContain("ack");
    expect(model.getCapturedInputs().length).toBeGreaterThan(0);

    await session.close();
  });

  it("entries from append are visible to the model on next compile", async () => {
    const model = createTestAdapter({ defaultResponse: "ok" });
    function A() {
      return (
        <>
          <Model model={model} />
          <System>T</System>
          <Timeline />
        </>
      );
    }
    const app = createApp(A, { maxTicks: 1 });
    const session = await app.session();

    await session.append({
      kind: "message",
      message: {
        role: "event",
        content: [{ type: "text", text: "AMBIENT_FACT_42" }],
        eventType: "marker",
      } as any,
    });

    // Now run a tick — the appended entry should be in the timeline that
    // gets compiled and sent to the model.
    await session.send({ messages: [{ role: "user", content: "go" }] }).result;

    const inputs = model.getCapturedInputs();
    expect(inputs.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(inputs);
    expect(serialized).toContain("AMBIENT_FACT_42");

    await session.close();
  });
});

// ============================================================================
// observe() — sugar
// ============================================================================

describe("session.observe()", () => {
  it("creates an event-role message entry", async () => {
    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    await session.observe({
      type: "file_opened",
      content: [{ type: "text", text: "/foo/bar.ts" }],
    });

    const snapshot = session.snapshot();
    expect(snapshot.timeline.length).toBe(1);
    const entry = snapshot.timeline[0] as any;
    expect(entry.kind).toBe("message");
    expect(entry.message.role).toBe("event");
    expect(entry.message.eventType).toBe("file_opened");

    await session.close();
  });

  it("accepts a string for content (sugar)", async () => {
    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    await session.observe({ type: "note", content: "user idle 30s" });

    const snapshot = session.snapshot();
    const entry = snapshot.timeline[0] as any;
    expect(entry.message.content[0].type).toBe("text");
    expect(entry.message.content[0].text).toBe("user idle 30s");

    await session.close();
  });

  it("does not trigger a tick", async () => {
    const model = createTestAdapter({ defaultResponse: "ok" });
    function A() {
      return (
        <>
          <Model model={model} />
          <System>T</System>
          <Timeline />
        </>
      );
    }
    const app = createApp(A, { maxTicks: 1 });
    const session = await app.session();

    await session.observe({ type: "x", content: "y" });
    expect(model.getCapturedInputs()).toHaveLength(0);

    await session.close();
  });

  it("appended events are visible to the model on next compile", async () => {
    const model = createTestAdapter({ defaultResponse: "ok" });
    function A() {
      return (
        <>
          <Model model={model} />
          <System>T</System>
          <Timeline />
        </>
      );
    }
    const app = createApp(A, { maxTicks: 1 });
    const session = await app.session();

    await session.observe({
      type: "marker",
      content: "OBSERVED_FACT_99",
    });

    await session.send({ messages: [{ role: "user", content: "go" }] }).result;

    const inputs = model.getCapturedInputs();
    const serialized = JSON.stringify(inputs);
    expect(serialized).toContain("OBSERVED_FACT_99");

    await session.close();
  });
});
