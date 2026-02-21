/**
 * Tool Confirmation Wiring Tests
 *
 * End-to-end tests for the session confirmation flow:
 * - Tool with requiresConfirmation emits tool_confirmation_required
 * - Approving via session.submitToolResult unblocks execution
 * - Rejecting via session.submitToolResult produces denial result
 */

import { describe, it, expect } from "vitest";
import { createApp } from "../app.js";
import { createTool } from "../tool/tool.js";
import { Model, Section } from "../jsx/components/primitives.js";
import { createTestAdapter } from "../testing/index.js";
import { z } from "zod";
import type {
  StreamEvent,
  ToolConfirmationRequiredEvent,
  ToolConfirmationResultEvent,
  ToolResultEvent,
} from "@agentick/shared";

function createConfirmableTool() {
  return createTool({
    name: "dangerous_action",
    description: "An action that requires confirmation",
    input: z.object({ target: z.string() }),
    requiresConfirmation: true,
    handler: ({ target }) => [{ type: "text" as const, text: `executed on ${target}` }],
  });
}

describe("tool confirmation wiring", () => {
  it("should emit confirmation events and execute tool when approved", async () => {
    const ConfirmTool = createConfirmableTool();
    const model = createTestAdapter({ defaultResponse: "Done" });
    model.respondWith([{ tool: { name: "dangerous_action", input: { target: "prod" } } }]);

    function Agent() {
      return (
        <>
          <ConfirmTool />
          <Model model={model} />
          <Section id="system" audience="model">
            Test
          </Section>
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 3 });
    const session = await app.session();
    const handle = await session.render({});

    const events: StreamEvent[] = [];
    for await (const event of handle) {
      events.push(event);

      // When we see a confirmation request, approve it
      if (event.type === "tool_confirmation_required") {
        session.submitToolResult(event.callId, { approved: true });
      }
    }

    // Verify confirmation_required event
    const confirmRequired = events.filter(
      (e): e is ToolConfirmationRequiredEvent => e.type === "tool_confirmation_required",
    );
    expect(confirmRequired).toHaveLength(1);
    expect(confirmRequired[0]!.name).toBe("dangerous_action");

    // Verify confirmation_result event
    const confirmResult = events.filter(
      (e): e is ToolConfirmationResultEvent => e.type === "tool_confirmation_result",
    );
    expect(confirmResult).toHaveLength(1);
    expect(confirmResult[0]!.confirmed).toBe(true);

    // Verify tool was executed
    const toolResults = events.filter((e): e is ToolResultEvent => e.type === "tool_result");
    const actionResult = toolResults.find((e) => e.name === "dangerous_action");
    expect(actionResult).toBeDefined();
    expect(actionResult!.isError).toBe(false);

    await session.close();
  });

  it("should produce denial result when rejected", async () => {
    const ConfirmTool = createConfirmableTool();
    const model = createTestAdapter({ defaultResponse: "Done" });
    model.respondWith([{ tool: { name: "dangerous_action", input: { target: "prod" } } }]);

    function Agent() {
      return (
        <>
          <ConfirmTool />
          <Model model={model} />
          <Section id="system" audience="model">
            Test
          </Section>
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 3 });
    const session = await app.session();
    const handle = await session.render({});

    const events: StreamEvent[] = [];
    for await (const event of handle) {
      events.push(event);

      // When we see a confirmation request, reject it
      if (event.type === "tool_confirmation_required") {
        session.submitToolResult(event.callId, {
          approved: false,
          reason: "too risky",
        });
      }
    }

    // Verify confirmation was rejected
    const confirmResult = events.filter(
      (e): e is ToolConfirmationResultEvent => e.type === "tool_confirmation_result",
    );
    expect(confirmResult).toHaveLength(1);
    expect(confirmResult[0]!.confirmed).toBe(false);

    // Tool result should indicate denial
    const toolResults = events.filter(
      (e): e is ToolResultEvent => e.type === "tool_result" && e.name === "dangerous_action",
    );
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.isError).toBe(true);

    await session.close();
  });
});
