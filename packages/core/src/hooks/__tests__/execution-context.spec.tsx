/**
 * Execution Context Hook Tests
 *
 * Tests for useOnExecutionStart and executionId on TickState.
 */

import { describe, it, expect } from "vitest";
import { createApp } from "../../app.js";
import { System, User } from "../../jsx/components/messages.js";
import { Model } from "../../jsx/components/primitives.js";
import { Timeline } from "../../jsx/components/timeline.js";
import { createTestAdapter } from "../../testing/index.js";
import { useOnTickStart } from "../../hooks/index.js";
import { useOnExecutionStart } from "../execution-context.js";
import type { TickState } from "../../component/component.js";

describe("executionId on TickState", () => {
  it("useOnTickStart receives executionId in tickState", async () => {
    const model = createTestAdapter({ defaultResponse: "Hello" });
    const tickStates: TickState[] = [];

    const Agent = () => {
      useOnTickStart((state) => {
        tickStates.push({ ...state });
      });
      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <User>Hi</User>
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }).result;
    session.close();

    // At least one tickState should have executionId
    const withExecId = tickStates.filter((ts) => ts.executionId);
    expect(withExecId.length).toBeGreaterThanOrEqual(1);
    expect(typeof withExecId[0].executionId).toBe("string");
  });

  it("executionId changes between separate send() calls", async () => {
    const model = createTestAdapter({ defaultResponse: "Hello" });
    const executionIds: string[] = [];

    const Agent = () => {
      useOnTickStart((state) => {
        if (state.executionId) {
          executionIds.push(state.executionId);
        }
      });
      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "first" }] }],
    }).result;

    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "second" }] }],
    }).result;
    session.close();

    expect(executionIds.length).toBeGreaterThanOrEqual(2);
    // Different executions should have different IDs
    const unique = new Set(executionIds);
    expect(unique.size).toBe(executionIds.length);
  });
});

describe("useOnExecutionStart", () => {
  it("fires once per execution, not per tick", async () => {
    const model = createTestAdapter({ defaultResponse: "Hello" });
    const executionStarts: string[] = [];

    const Agent = () => {
      useOnExecutionStart((executionId) => {
        executionStarts.push(executionId);
      });
      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
          <User>Hi</User>
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();
    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }).result;
    session.close();

    // Exactly 1 execution start
    expect(executionStarts.length).toBe(1);
    expect(typeof executionStarts[0]).toBe("string");
  });

  it("fires once per send() across multiple sends", async () => {
    const model = createTestAdapter({ defaultResponse: "Hello" });
    const executionStarts: string[] = [];

    const Agent = () => {
      useOnExecutionStart((executionId) => {
        executionStarts.push(executionId);
      });
      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    };

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "first" }] }],
    }).result;

    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "second" }] }],
    }).result;

    await session.send({
      messages: [{ role: "user", content: [{ type: "text", text: "third" }] }],
    }).result;
    session.close();

    // 3 sends = 3 execution starts
    expect(executionStarts.length).toBe(3);
    // All different IDs
    const unique = new Set(executionStarts);
    expect(unique.size).toBe(3);
  });
});
