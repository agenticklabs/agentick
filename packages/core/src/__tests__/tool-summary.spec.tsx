/**
 * Tool displaySummary Tests
 *
 * Validates that displaySummary on a tool definition surfaces on
 * tool_call stream events emitted by the session.
 */

import { describe, it, expect } from "vitest";
import { createApp } from "../app";
import { createTool } from "../tool/tool";
import { Model, Section } from "../jsx/components/primitives";
import { createTestAdapter } from "../testing";
import { z } from "zod";
import type { StreamEvent, ToolCallEvent } from "@agentick/shared";

describe("tool displaySummary", () => {
  it("should include summary in tool_call stream events", async () => {
    const SearchTool = createTool({
      name: "search",
      description: "Search for something",
      input: z.object({ query: z.string() }),
      displaySummary: (input) => `searching: ${input.query}`,
      handler: () => [{ type: "text" as const, text: "result" }],
    });

    const model = createTestAdapter({ defaultResponse: "Done" });
    model.respondWith([{ tool: { name: "search", input: { query: "test" } } }]);

    function Agent() {
      return (
        <>
          <SearchTool />
          <Section id="system" audience="model">
            Test agent
          </Section>
          <Model model={model} />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 3 });
    const session = await app.session();
    const handle = await session.render({});

    const events: StreamEvent[] = [];
    for await (const event of handle) {
      events.push(event);
    }

    const toolCallEvents = events.filter((e): e is ToolCallEvent => e.type === "tool_call");

    // Exactly one tool_call event per invocation — enriched with summary
    // during the streaming passthrough (no duplicate from Phase 3).
    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0].summary).toBe("searching: test");

    await session.close();
  });

  it("should set summary to undefined when displaySummary throws", async () => {
    const BrokenTool = createTool({
      name: "broken_summary",
      description: "Tool with broken summary",
      input: z.object({ value: z.string() }),
      displaySummary: () => {
        throw new Error("summary failed");
      },
      handler: () => [{ type: "text" as const, text: "ok" }],
    });

    const model = createTestAdapter({ defaultResponse: "Done" });
    model.respondWith([{ tool: { name: "broken_summary", input: { value: "x" } } }]);

    function Agent() {
      return (
        <>
          <BrokenTool />
          <Section id="system" audience="model">
            Test agent
          </Section>
          <Model model={model} />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 3 });
    const session = await app.session();
    const handle = await session.render({});

    const events: StreamEvent[] = [];
    for await (const event of handle) {
      events.push(event);
    }

    const toolCallEvents = events.filter((e): e is ToolCallEvent => e.type === "tool_call");

    expect(toolCallEvents.length).toBeGreaterThanOrEqual(1);
    // When displaySummary throws, NO tool_call event should have a summary.
    // Contrast with the happy-path test where .find(e => e.summary) succeeds.
    const withSummary = toolCallEvents.find((e) => e.summary !== undefined);
    expect(withSummary).toBeUndefined();

    await session.close();
  });

  it("should set summary to undefined when tool has no displaySummary", async () => {
    const PlainTool = createTool({
      name: "plain",
      description: "Tool without summary",
      input: z.object({ x: z.string() }),
      handler: () => [{ type: "text" as const, text: "ok" }],
    });

    const model = createTestAdapter({ defaultResponse: "Done" });
    model.respondWith([{ tool: { name: "plain", input: { x: "val" } } }]);

    function Agent() {
      return (
        <>
          <PlainTool />
          <Section id="system" audience="model">
            Test agent
          </Section>
          <Model model={model} />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 3 });
    const session = await app.session();
    const handle = await session.render({});

    const events: StreamEvent[] = [];
    for await (const event of handle) {
      events.push(event);
    }

    const toolCallEvents = events.filter((e): e is ToolCallEvent => e.type === "tool_call");

    expect(toolCallEvents.length).toBeGreaterThanOrEqual(1);
    // No displaySummary defined → no tool_call event should carry a summary.
    const withSummary = toolCallEvents.find((e) => e.summary !== undefined);
    expect(withSummary).toBeUndefined();

    await session.close();
  });
});
