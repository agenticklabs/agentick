/**
 * Session UI Tool Tests
 *
 * Tests that tools with `ui.resourceUri` metadata correctly populate
 * `call.ui` with an appSessionId, and that the tool_result_start event
 * carries the UI metadata so the host knows to mount an app.
 *
 * The tool still executes normally — the UI metadata is an annotation,
 * not a different execution path.
 */

import { describe, it, expect } from "vitest";
import { createApp } from "../../app.js";
import { createTool } from "../../tool/tool.js";
import { System, User } from "../../jsx/components/messages.js";
import { Model } from "../../jsx/components/primitives.js";
import { Timeline } from "../../jsx/components/timeline.js";
import { createTestAdapter } from "../../testing/index.js";
import type { StreamEvent } from "@agentick/shared";
import { z } from "zod";

// ============================================================================
// Test tool with UI metadata
// ============================================================================

const DashboardTool = createTool({
  name: "show_dashboard",
  description: "Show the project dashboard",
  input: z.object({ projectId: z.number() }),
  ui: {
    resourceUri: "ui://test-server/dashboard",
    visibility: ["model", "app"],
  },
  handler: async (input) => {
    return [{ type: "text" as const, text: `Dashboard for project ${input.projectId}` }];
  },
});

// Regular tool without UI for comparison
const RegularTool = createTool({
  name: "search",
  description: "Search for stuff",
  input: z.object({ query: z.string() }),
  handler: async (input) => {
    return [{ type: "text" as const, text: `Results for: ${input.query}` }];
  },
});

// ============================================================================
// Helpers
// ============================================================================

function collectEvents(handle: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  return new Promise((resolve) => {
    const events: StreamEvent[] = [];
    (async () => {
      for await (const event of handle) {
        events.push(event);
      }
      resolve(events);
    })();
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("Session — UI tool metadata", () => {
  it("tool_result_start carries ui metadata when tool has resourceUri", async () => {
    const model = createTestAdapter();
    model.respondWith([{ tool: { name: "show_dashboard", input: { projectId: 42 } } }]);

    const Agent = () => (
      <>
        <Model model={model} />
        <System>You are a test agent.</System>
        <DashboardTool />
        <User>Show me the dashboard for project 42</User>
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 2 });
    const session = await app.session();
    const handle = await session.render({} as any);
    const events = await collectEvents(handle);

    // Find the tool_result_start event
    const toolResultStart = events.find(
      (e) => e.type === "tool_result_start" && (e as any).name === "show_dashboard",
    );

    expect(toolResultStart).toBeDefined();
    expect((toolResultStart as any).ui).toBeDefined();
    expect((toolResultStart as any).ui.resourceUri).toBe("ui://test-server/dashboard");
    expect((toolResultStart as any).ui.appSessionId).toBeDefined();
    expect(typeof (toolResultStart as any).ui.appSessionId).toBe("string");
    // appSessionId should be a UUID
    expect((toolResultStart as any).ui.appSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("tool_result_start does NOT carry ui metadata for regular tools", async () => {
    const model = createTestAdapter();
    model.respondWith([{ tool: { name: "search", input: { query: "test" } } }]);

    const Agent = () => (
      <>
        <Model model={model} />
        <System>You are a test agent.</System>
        <RegularTool />
        <User>Search for test</User>
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 2 });
    const session = await app.session();
    const handle = await session.render({} as any);
    const events = await collectEvents(handle);

    const toolResultStart = events.find(
      (e) => e.type === "tool_result_start" && (e as any).name === "search",
    );

    expect(toolResultStart).toBeDefined();
    expect((toolResultStart as any).ui).toBeUndefined();
  });

  it("UI tool still executes and returns a result", async () => {
    const model = createTestAdapter();
    model.respondWith([{ tool: { name: "show_dashboard", input: { projectId: 99 } } }]);

    const Agent = () => (
      <>
        <Model model={model} />
        <System>You are a test agent.</System>
        <DashboardTool />
        <User>Show dashboard</User>
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 2 });
    const session = await app.session();
    const handle = await session.render({} as any);
    const events = await collectEvents(handle);

    // Tool result should have the handler's output
    const toolResult = events.find(
      (e) => e.type === "tool_result" && (e as any).name === "show_dashboard",
    );

    expect(toolResult).toBeDefined();
    expect((toolResult as any).isError).toBe(false);
    expect((toolResult as any).result.content[0].text).toBe("Dashboard for project 99");
  });

  it("resolveContent is called and result is attached to ui.content", async () => {
    const ResolvedTool = createTool({
      name: "resolved_app",
      description: "Tool with a resolveContent hook",
      input: z.object({}),
      ui: {
        resourceUri: "ui://test/resolved",
        resolveContent: async () => "<!DOCTYPE html><html><body>Resolved!</body></html>",
      },
      handler: async () => [{ type: "text" as const, text: "ok" }],
    });

    const model = createTestAdapter();
    model.respondWith([{ tool: { name: "resolved_app", input: {} } }]);

    const Agent = () => (
      <>
        <Model model={model} />
        <System>test</System>
        <ResolvedTool />
        <User>show app</User>
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 2 });
    const session = await app.session();
    const handle = await session.render({} as any);
    const events = await collectEvents(handle);

    const toolResultStart = events.find(
      (e) => e.type === "tool_result_start" && (e as any).name === "resolved_app",
    );

    expect(toolResultStart).toBeDefined();
    expect((toolResultStart as any).ui).toBeDefined();
    expect((toolResultStart as any).ui.content).toBe(
      "<!DOCTYPE html><html><body>Resolved!</body></html>",
    );
  });

  it("resolveContent failure is non-fatal — event still emits without content", async () => {
    const FailingTool = createTool({
      name: "failing_app",
      description: "Tool whose resolver throws",
      input: z.object({}),
      ui: {
        resourceUri: "ui://test/failing",
        resolveContent: async () => {
          throw new Error("resolver failed");
        },
      },
      handler: async () => [{ type: "text" as const, text: "ok" }],
    });

    const model = createTestAdapter();
    model.respondWith([{ tool: { name: "failing_app", input: {} } }]);

    const Agent = () => (
      <>
        <Model model={model} />
        <System>test</System>
        <FailingTool />
        <User>show app</User>
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 2 });
    const session = await app.session();
    const handle = await session.render({} as any);
    const events = await collectEvents(handle);

    const toolResultStart = events.find(
      (e) => e.type === "tool_result_start" && (e as any).name === "failing_app",
    );

    // Event still emits with ui metadata (resourceUri, appSessionId) but no content
    expect(toolResultStart).toBeDefined();
    expect((toolResultStart as any).ui).toBeDefined();
    expect((toolResultStart as any).ui.resourceUri).toBe("ui://test/failing");
    expect((toolResultStart as any).ui.content).toBeUndefined();
  });

  it("each UI tool call gets a unique appSessionId", async () => {
    const model = createTestAdapter();
    // Two tool calls in sequence
    model.respondWith([
      {
        tool: [
          { name: "show_dashboard", input: { projectId: 1 } },
          { name: "show_dashboard", input: { projectId: 2 } },
        ],
      },
    ]);

    const Agent = () => (
      <>
        <Model model={model} />
        <System>You are a test agent.</System>
        <DashboardTool />
        <User>Show both dashboards</User>
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 2 });
    const session = await app.session();
    const handle = await session.render({} as any);
    const events = await collectEvents(handle);

    const uiEvents = events.filter((e) => e.type === "tool_result_start" && (e as any).ui);

    expect(uiEvents).toHaveLength(2);
    const id1 = (uiEvents[0] as any).ui.appSessionId;
    const id2 = (uiEvents[1] as any).ui.appSessionId;
    expect(id1).not.toBe(id2);
  });
});
