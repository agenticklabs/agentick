/**
 * execution_end timeline delta tests.
 *
 * Verifies that execution_end events include `newTimelineEntries` containing
 * only the entries added during that execution, not the full timeline.
 */

import { describe, it, expect } from "vitest";
import { createApp } from "../../app";
import { System } from "../../jsx/components/messages";
import { Model } from "../../jsx/components/primitives";
import { Timeline } from "../../jsx/components/timeline";
import { createTestAdapter } from "../../testing";
import type { StreamEvent as SharedStreamEvent } from "@agentick/shared";

type ExecutionEndPayload = SharedStreamEvent & {
  newTimelineEntries?: Array<{ kind?: string; message?: { role: string } }>;
  output?: { timeline?: Array<{ kind?: string; message?: { role: string } }> };
};

function createMockModel() {
  return createTestAdapter({ defaultResponse: "Mock response" });
}

function collectExecutionEnds(session: { on: (event: string, cb: (e: any) => void) => void }) {
  const events: ExecutionEndPayload[] = [];
  session.on("event", (event: ExecutionEndPayload) => {
    if (event.type === "execution_end") {
      events.push(event);
    }
  });
  return events;
}

describe("execution_end timeline delta", () => {
  it("should include newTimelineEntries on execution_end", async () => {
    const model = createMockModel();

    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();
    const events = collectExecutionEnds(session);

    // Use send() with messages so user message goes into timeline
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }).result;

    expect(events).toHaveLength(1);
    const execEnd = events[0];

    expect(execEnd.newTimelineEntries).toBeDefined();
    expect(Array.isArray(execEnd.newTimelineEntries)).toBe(true);
    // At minimum: user message + assistant response
    expect(execEnd.newTimelineEntries!.length).toBeGreaterThanOrEqual(2);

    const messageEntries = execEnd.newTimelineEntries!.filter((e) => e.kind === "message");
    const roles = messageEntries.map((e) => e.message?.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");

    await session.close();
  });

  it("delta should only contain entries from the current execution", async () => {
    const model = createMockModel();

    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();
    const events = collectExecutionEnds(session);

    // First execution
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "First" }] }],
    }).result;

    const firstDeltaLength = events[0].newTimelineEntries!.length;

    // Second execution
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Second" }] }],
    }).result;

    expect(events).toHaveLength(2);

    const secondDelta = events[1].newTimelineEntries!;
    const secondFull = events[1].output?.timeline ?? [];

    // Delta for second should be roughly the same size as first (one user + one assistant)
    // NOT the full timeline which grows each execution
    expect(secondDelta.length).toBeLessThanOrEqual(firstDeltaLength + 1);

    // Full timeline should be bigger than the delta
    expect(secondFull.length).toBeGreaterThan(secondDelta.length);

    await session.close();
  });

  it("full output.timeline should contain the complete timeline across executions", async () => {
    const model = createMockModel();

    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();
    const events = collectExecutionEnds(session);

    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "First" }] }],
    }).result;

    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Second" }] }],
    }).result;

    const firstFull = events[0].output?.timeline ?? [];
    const secondFull = events[1].output?.timeline ?? [];

    // Second execution's full timeline should include entries from both executions
    expect(secondFull.length).toBeGreaterThan(firstFull.length);

    // Both user messages should be in the full timeline
    const allUserMessages = secondFull.filter(
      (e) => e.kind === "message" && e.message?.role === "user",
    );
    expect(allUserMessages.length).toBeGreaterThanOrEqual(2);

    await session.close();
  });

  it("delta should match output.timeline on first execution", async () => {
    const model = createMockModel();

    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();
    const events = collectExecutionEnds(session);

    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }).result;

    const delta = events[0].newTimelineEntries!;
    const full = events[0].output?.timeline ?? [];

    // On first execution, delta and full should be identical
    // (nothing existed before this execution)
    expect(delta.length).toBe(full.length);

    await session.close();
  });
});
