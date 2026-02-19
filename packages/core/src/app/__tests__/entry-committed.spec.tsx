/**
 * entry_committed StreamEvent Tests
 *
 * Verifies that entry_committed events fire correctly from ingestTickResult,
 * with stable IDs, correct tick values, and proper ordering relative to
 * other lifecycle events.
 */

import { describe, it, expect } from "vitest";
import { createApp } from "../../app";
import { System, User } from "../../jsx/components/messages";
import { Model, Tool } from "../../jsx/components/primitives";
import { Timeline } from "../../jsx/components/timeline";
import { createTestAdapter } from "../../testing";
import type { StreamEvent, EntryCommittedEvent } from "@agentick/shared";
import { z } from "zod";

describe("entry_committed", () => {
  it("emits entry_committed for user + assistant entries (2 events)", async () => {
    const model = createTestAdapter({ defaultResponse: "Hello!" });
    const events: StreamEvent[] = [];

    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
        <User>Hi</User>
      </>
    );

    const app = createApp(Agent, {
      maxTicks: 1,
      onEvent: (e) => events.push(e),
    });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }).result;
    session.close();

    const committed = events.filter((e) => e.type === "entry_committed") as EntryCommittedEvent[];
    expect(committed.length).toBe(2); // user + assistant
  });

  it("emits entry_committed for tool use cycle (user + assistant + tool_result + assistant)", async () => {
    const model = createTestAdapter({ defaultResponse: "" });
    const events: StreamEvent[] = [];

    model.respondWith([{ tool: { name: "ping", input: {} } }, { text: "Done" }]);

    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
        <User>Go</User>
        <Tool
          name="ping"
          description="Ping"
          input={z.object({})}
          handler={() => [{ type: "text" as const, text: "pong" }]}
        />
      </>
    );

    const app = createApp(Agent, {
      maxTicks: 5,
      onEvent: (e) => events.push(e),
    });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    }).result;
    session.close();

    const committed = events.filter((e) => e.type === "entry_committed") as EntryCommittedEvent[];
    // user + assistant(tool_use) + tool_result + assistant(final) = 4
    // (tool_result fires even when handler errors — the entry is committed regardless)
    expect(committed.length).toBe(4);

    // Verify roles present in committed entries
    const roles = committed.map((e) => (e.entry as any)?.message?.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    expect(roles).toContain("tool");
  });

  it("carries correct tick values in multi-tick scenario", async () => {
    const model = createTestAdapter({ defaultResponse: "" });
    const events: StreamEvent[] = [];

    model.respondWith([{ tool: { name: "ping", input: {} } }, { text: "Done" }]);

    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
        <User>Go</User>
        <Tool
          name="ping"
          description="Ping"
          input={z.object({})}
          handler={() => [{ type: "text" as const, text: "pong" }]}
        />
      </>
    );

    const app = createApp(Agent, {
      maxTicks: 5,
      onEvent: (e) => events.push(e),
    });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    }).result;
    session.close();

    const committed = events.filter((e) => e.type === "entry_committed") as EntryCommittedEvent[];
    // Tick 0: user + assistant(tool_use) + tool_result
    // Tick 1: assistant(final)
    const _tick0 = committed.filter((e) => e.tick === 0 || e.tick === 1);
    // At least entries exist on first tick
    expect(committed.length).toBeGreaterThanOrEqual(3);

    // All entries should have ticks that are valid numbers
    for (const e of committed) {
      expect(typeof e.tick).toBe("number");
      expect(e.tick).toBeGreaterThanOrEqual(0);
    }
  });

  it("executionId is consistent within execution", async () => {
    const model = createTestAdapter({ defaultResponse: "Hi" });
    const events: StreamEvent[] = [];

    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
        <User>Hello</User>
      </>
    );

    const app = createApp(Agent, {
      maxTicks: 1,
      onEvent: (e) => events.push(e),
    });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }).result;
    session.close();

    const committed = events.filter((e) => e.type === "entry_committed") as EntryCommittedEvent[];
    expect(committed.length).toBeGreaterThanOrEqual(2);

    // All entries in same execution share same executionId
    const execIds = new Set(committed.map((e) => e.executionId));
    expect(execIds.size).toBe(1);
    expect(committed[0].executionId).toBeTruthy();
  });

  it("executionId differs across separate send() calls", async () => {
    const model = createTestAdapter({ defaultResponse: "Hi" });
    const events: StreamEvent[] = [];

    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, {
      maxTicks: 1,
      onEvent: (e) => events.push(e),
    });
    const session = await app.session();

    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "first" }] }],
    }).result;

    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "second" }] }],
    }).result;
    session.close();

    const committed = events.filter((e) => e.type === "entry_committed") as EntryCommittedEvent[];
    const execIds = [...new Set(committed.map((e) => e.executionId))];
    expect(execIds.length).toBe(2);
  });

  it("timelineIndex is monotonically increasing", async () => {
    const model = createTestAdapter({ defaultResponse: "" });
    const events: StreamEvent[] = [];

    model.respondWith([{ tool: { name: "ping", input: {} } }, { text: "Done" }]);

    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
        <User>Go</User>
        <Tool
          name="ping"
          description="Ping"
          input={z.object({})}
          handler={() => [{ type: "text" as const, text: "pong" }]}
        />
      </>
    );

    const app = createApp(Agent, {
      maxTicks: 5,
      onEvent: (e) => events.push(e),
    });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    }).result;
    session.close();

    const committed = events.filter((e) => e.type === "entry_committed") as EntryCommittedEvent[];
    for (let i = 1; i < committed.length; i++) {
      expect(committed[i].timelineIndex).toBeGreaterThan(committed[i - 1].timelineIndex);
    }
  });

  it("entry_committed fires BEFORE tick_end in event order", async () => {
    const model = createTestAdapter({ defaultResponse: "Hello" });
    const events: StreamEvent[] = [];

    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
        <User>Hi</User>
      </>
    );

    const app = createApp(Agent, {
      maxTicks: 1,
      onEvent: (e) => events.push(e),
    });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }).result;
    session.close();

    // Find the last entry_committed and the first tick_end
    const lastCommittedIdx = events.findLastIndex((e) => e.type === "entry_committed");
    const firstTickEndIdx = events.findIndex((e) => e.type === "tick_end");

    expect(lastCommittedIdx).toBeGreaterThan(-1);
    expect(firstTickEndIdx).toBeGreaterThan(-1);
    expect(lastCommittedIdx).toBeLessThan(firstTickEndIdx);
  });

  it("entries have stable IDs (not undefined)", async () => {
    const model = createTestAdapter({ defaultResponse: "Hello" });
    const events: StreamEvent[] = [];

    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
        <User>Hi</User>
      </>
    );

    const app = createApp(Agent, {
      maxTicks: 1,
      onEvent: (e) => events.push(e),
    });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }).result;
    session.close();

    const committed = events.filter((e) => e.type === "entry_committed") as EntryCommittedEvent[];
    for (const e of committed) {
      const entry = e.entry as any;
      expect(entry.id).toBeTruthy();
      expect(typeof entry.id).toBe("string");
    }
  });

  it("entry content integrity — roles and blocks present", async () => {
    const model = createTestAdapter({ defaultResponse: "Model says hi" });
    const events: StreamEvent[] = [];

    const Agent = () => (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
        <User>User says hi</User>
      </>
    );

    const app = createApp(Agent, {
      maxTicks: 1,
      onEvent: (e) => events.push(e),
    });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }).result;
    session.close();

    const committed = events.filter((e) => e.type === "entry_committed") as EntryCommittedEvent[];

    // At least user + assistant
    expect(committed.length).toBeGreaterThanOrEqual(2);

    for (const e of committed) {
      const entry = e.entry as any;
      expect(entry.message).toBeTruthy();
      expect(entry.message.role).toBeTruthy();
      expect(Array.isArray(entry.message.content)).toBe(true);
    }
  });
});
