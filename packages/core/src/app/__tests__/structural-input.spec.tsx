/**
 * Structural SendInput Integration Tests
 *
 * Verifies that system, grounding, sections, and ephemeral fields on SendInput
 * flow through session compilation and appear in the model's input.
 */

import { describe, it, expect } from "vitest";
import { createApp, Model, Section, System, Timeline } from "../../index.js";
import { createTestAdapter } from "../../testing/index.js";
import { createTool } from "../../tool/tool.js";
import { z } from "zod";
import type { ModelInput } from "../../model/model.js";
import type { Message } from "@agentick/shared";

function createCapturingModel() {
  const model = createTestAdapter({ defaultResponse: "OK" });
  return {
    model,
    getCapturedInputs: () => model.getCapturedInputs(),
    clearCapturedInputs: () => model.clearCapturedInputs(),
  };
}

function messagesText(input: ModelInput): string[] {
  return (input.messages as Message[]).flatMap((m) =>
    (m.content as any[]).filter((b: any) => b.type === "text").map((b: any) => b.text as string),
  );
}

describe("Structural SendInput", () => {
  it("system strings appear in model input system messages", async () => {
    const { model, getCapturedInputs } = createCapturingModel();

    const Agent = () => (
      <>
        <Model model={model} />
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    await (
      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        system: ["You are helpful.", "Be concise."],
      })
    ).result;

    const inputs = getCapturedInputs();
    expect(inputs.length).toBeGreaterThanOrEqual(1);

    // System strings should appear in the model's system messages
    const _allText = messagesText(inputs[0]!);
    const systemMessages = (inputs[0]!.messages as Message[]).filter(
      (m: any) => m.role === "system",
    );
    const systemTexts = systemMessages.flatMap((m) =>
      (m.content as any[]).filter((b: any) => b.type === "text").map((b: any) => b.text),
    );

    expect(systemTexts).toContain("You are helpful.");
    expect(systemTexts).toContain("Be concise.");

    await session.close();
  });

  it("grounding appears in model messages with grounding content", async () => {
    const { model, getCapturedInputs } = createCapturingModel();

    const Agent = () => (
      <>
        <Model model={model} />
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    await (
      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        grounding: [{ title: "Context", audience: "model", content: "Current state: active" }],
      })
    ).result;

    const inputs = getCapturedInputs();
    expect(inputs.length).toBeGreaterThanOrEqual(1);

    // Grounding content should appear somewhere in the messages
    const allText = messagesText(inputs[0]!);
    expect(allText.some((t) => t.includes("Current state: active"))).toBe(true);

    await session.close();
  });

  it("sections appear in model input as system message", async () => {
    const { model, getCapturedInputs } = createCapturingModel();

    const Agent = () => (
      <>
        <Model model={model} />
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    await (
      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        sections: [{ id: "rules", title: "Rules", content: "Be nice.", audience: "model" }],
      })
    ).result;

    const inputs = getCapturedInputs();
    expect(inputs.length).toBeGreaterThanOrEqual(1);

    // Section with audience "model" should appear in system messages
    // (fromEngineState converts sections to system when no System JSX exists)
    const allText = messagesText(inputs[0]!);
    expect(allText.some((t) => t.includes("Be nice."))).toBe(true);

    await session.close();
  });

  it("ephemeral appears in model messages", async () => {
    const { model, getCapturedInputs } = createCapturingModel();

    const Agent = () => (
      <>
        <Model model={model} />
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    await (
      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        ephemeral: [{ content: "Current time: now", position: "before-user" }],
      })
    ).result;

    const inputs = getCapturedInputs();
    expect(inputs.length).toBeGreaterThanOrEqual(1);

    const allText = messagesText(inputs[0]!);
    expect(allText.some((t) => t.includes("Current time: now"))).toBe(true);

    await session.close();
  });

  it("JSX System + input system are both additive", async () => {
    const { model, getCapturedInputs } = createCapturingModel();

    const Agent = () => (
      <>
        <Model model={model} />
        <System>You are a coding assistant.</System>
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    await (
      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        system: ["Also be concise."],
      })
    ).result;

    const inputs = getCapturedInputs();
    expect(inputs.length).toBeGreaterThanOrEqual(1);

    const systemMessages = (inputs[0]!.messages as Message[]).filter(
      (m: any) => m.role === "system",
    );
    const systemTexts = systemMessages.flatMap((m) =>
      (m.content as any[]).filter((b: any) => b.type === "text").map((b: any) => b.text),
    );

    expect(systemTexts.some((t: string) => t.includes("coding assistant"))).toBe(true);
    expect(systemTexts).toContain("Also be concise.");

    await session.close();
  });

  it("JSX section wins on ID collision", async () => {
    const { model, getCapturedInputs } = createCapturingModel();

    const Agent = () => (
      <>
        <Model model={model} />
        <Section id="rules" audience="model">
          JSX rules content
        </Section>
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    await (
      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        sections: [
          { id: "rules", title: "Input Rules", content: "Input content", audience: "model" },
        ],
      })
    ).result;

    const inputs = getCapturedInputs();
    expect(inputs.length).toBeGreaterThanOrEqual(1);

    // JSX content should win — the structural input section is skipped on ID collision
    const allText = messagesText(inputs[0]!);
    expect(allText.some((t) => t.includes("JSX rules content"))).toBe(true);
    expect(allText.some((t) => t.includes("Input content"))).toBe(false);

    await session.close();
  });

  it("sequential sends: second send without structural → clean slate", async () => {
    const { model, getCapturedInputs, clearCapturedInputs } = createCapturingModel();

    const Agent = () => (
      <>
        <Model model={model} />
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // First send with system
    await (
      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "first" }] }],
        system: ["Be helpful."],
      })
    ).result;

    clearCapturedInputs();

    // Second send without structural
    await (
      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "second" }] }],
      })
    ).result;

    const inputs = getCapturedInputs();
    expect(inputs.length).toBeGreaterThanOrEqual(1);

    // "Be helpful." should NOT appear in the second call's system messages
    const systemMessages = (inputs[0]!.messages as Message[]).filter(
      (m: any) => m.role === "system",
    );
    const systemTexts = systemMessages.flatMap((m) =>
      (m.content as any[]).filter((b: any) => b.type === "text").map((b: any) => b.text),
    );
    expect(systemTexts).not.toContain("Be helpful.");

    await session.close();
  });

  it("multi-tick: structural input persists through tool-use continuation", async () => {
    const model = createTestAdapter({ defaultResponse: "Done" });

    const NoopTool = createTool({
      name: "noop",
      description: "Does nothing",
      input: z.object({}),
      handler: async () => [{ type: "text" as const, text: "ok" }],
    });

    // First call: model uses tool → triggers tick 2. Second call: model returns text.
    model.respondWith([{ tool: { name: "noop", input: {} } }]);

    const Agent = () => (
      <>
        <Model model={model} />
        <NoopTool />
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 3 });
    const session = await app.session();

    model.clearCapturedInputs();

    await (
      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "do something" }] }],
        system: ["Persist across ticks."],
      })
    ).result;

    const inputs = model.getCapturedInputs();
    // 2 model calls: tick 1 (tool call) + tick 2 (final response)
    expect(inputs.length).toBe(2);

    // BOTH ticks should see the structural system string
    for (const input of inputs) {
      const systemMessages = (input.messages as Message[]).filter((m: any) => m.role === "system");
      const systemTexts = systemMessages.flatMap((m) =>
        (m.content as any[]).filter((b: any) => b.type === "text").map((b: any) => b.text),
      );
      expect(systemTexts).toContain("Persist across ticks.");
    }

    // Verify multi-tick happened: tick 2 should have tool results
    const tick2Messages = inputs[1]!.messages as Message[];
    expect(tick2Messages.some((m: any) => m.role === "tool")).toBe(true);

    await session.close();
  });

  it("spawn() with structural input flows to child session", async () => {
    const parentModel = createTestAdapter({ defaultResponse: "Parent done" });
    const childModel = createTestAdapter({ defaultResponse: "Child done" });

    const ChildAgent = () => (
      <>
        <Model model={childModel} />
        <Timeline />
      </>
    );

    const Agent = () => (
      <>
        <Model model={parentModel} />
        <Timeline />
      </>
    );

    const app = createApp(Agent, { maxTicks: 1 });
    const session = await app.session();

    // Spawn child with structural grounding
    const childHandle = await session.spawn(ChildAgent, {
      messages: [{ role: "user", content: [{ type: "text", text: "hello child" }] }],
      grounding: [{ title: "Parent Context", content: "Child should see this", audience: "model" }],
      system: ["Child system instruction."],
    });

    await childHandle.result;

    const childInputs = childModel.getCapturedInputs();
    expect(childInputs.length).toBeGreaterThanOrEqual(1);

    // Grounding content should appear in child's model input
    const allText = messagesText(childInputs[0]!);
    expect(allText.some((t) => t.includes("Child should see this"))).toBe(true);

    // System instruction should appear in child's system messages
    const systemMessages = (childInputs[0]!.messages as Message[]).filter(
      (m: any) => m.role === "system",
    );
    const systemTexts = systemMessages.flatMap((m) =>
      (m.content as any[]).filter((b: any) => b.type === "text").map((b: any) => b.text),
    );
    expect(systemTexts).toContain("Child system instruction.");

    await session.close();
  });
});
