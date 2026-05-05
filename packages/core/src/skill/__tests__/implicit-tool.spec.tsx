/**
 * Implicit `skill` tool + app.skills integration.
 *
 * Covers:
 * - Implicit tool auto-mounted when app.skills is non-empty
 * - Tool description includes registered skill names + descriptions
 * - Tool handler returns rendered SKILL.md body (with substitution applied)
 * - session.skill(name, ...) resolves via app.skills registry
 * - Tool is absent when registry is empty
 */

import { describe, it, expect } from "vitest";
import React from "react";
import { z } from "zod";
import { defineSkill } from "../skill.js";
import { createApp } from "../../app.js";
import { System } from "../../jsx/components/messages.js";
import { Model } from "../../jsx/components/primitives.js";
import { Timeline } from "../../jsx/components/timeline.js";
import { createTestAdapter } from "../../testing/index.js";

function makeAgent(model: ReturnType<typeof createTestAdapter>) {
  return function Agent() {
    return (
      <>
        <Model model={model} />
        <System>Test</System>
        <Timeline />
      </>
    );
  };
}

describe("implicit `skill` tool", () => {
  it("is auto-mounted when app.skills has any registered skills", async () => {
    const model = createTestAdapter({ defaultResponse: "ok" });
    const app = createApp(makeAgent(model), { maxTicks: 1 });

    app.skills.register(
      defineSkill({
        name: "triage",
        description: "Triage an issue.",
        instructions: "Triage instructions.",
      }),
    );

    const session = await app.session();
    await session.send({ messages: [{ role: "user", content: "hi" }] }).result;

    const inputs = model.getCapturedInputs();
    const lastInput = inputs[inputs.length - 1];
    const toolNames = (lastInput.tools ?? []).map((t: any) => t.name);
    expect(toolNames).toContain("skill");

    await session.close();
  });

  it("is NOT mounted when app.skills is empty", async () => {
    const model = createTestAdapter({ defaultResponse: "ok" });
    const app = createApp(makeAgent(model), { maxTicks: 1 });
    const session = await app.session();
    await session.send({ messages: [{ role: "user", content: "hi" }] }).result;

    const lastInput = model.getCapturedInputs().slice(-1)[0];
    const toolNames = (lastInput.tools ?? []).map((t: any) => t.name);
    expect(toolNames).not.toContain("skill");

    await session.close();
  });

  it("tool description lists registered skill names + descriptions", async () => {
    const model = createTestAdapter({ defaultResponse: "ok" });
    const app = createApp(makeAgent(model), { maxTicks: 1 });

    app.skills.register(
      defineSkill({
        name: "triage",
        description: "Investigate an issue.",
        instructions: "x",
      }),
    );
    app.skills.register(
      defineSkill({
        name: "plan",
        description: "Make a step plan.",
        instructions: "x",
      }),
    );

    const session = await app.session();
    await session.send({ messages: [{ role: "user", content: "hi" }] }).result;

    const lastInput = model.getCapturedInputs().slice(-1)[0];
    const skillTool = (lastInput.tools ?? []).find((t: any) => t.name === "skill");
    expect(skillTool).toBeDefined();
    expect(skillTool.description).toContain("triage");
    expect(skillTool.description).toContain("Investigate an issue.");
    expect(skillTool.description).toContain("plan");
    expect(skillTool.description).toContain("Make a step plan.");

    await session.close();
  });

  it("tool handler returns rendered SKILL.md body (with substitution)", async () => {
    const model = createTestAdapter({ defaultResponse: "ok" });
    const app = createApp(makeAgent(model), { maxTicks: 1 });

    app.skills.register(
      defineSkill({
        name: "greet",
        description: "Greet someone.",
        instructions: "Say hello to $name in $language.",
      }),
    );

    const session = await app.session();
    await session.mount();

    // Use dispatch to invoke the implicit skill tool directly
    const result = await session.dispatch("skill", {
      name: "greet",
      args: { name: "Ryan", language: "Spanish" },
    });

    const text = (result[0] as any).text;
    expect(text).toBe("Say hello to Ryan in Spanish.");

    await session.close();
  });

  it("tool errors with available list when name is unknown", async () => {
    const model = createTestAdapter({ defaultResponse: "ok" });
    const app = createApp(makeAgent(model), { maxTicks: 1 });

    app.skills.register(
      defineSkill({
        name: "alpha",
        description: "x",
        instructions: "y",
      }),
    );

    const session = await app.session();
    await session.mount();

    await expect(session.dispatch("skill", { name: "bravo" })).rejects.toThrow(
      /Unknown skill: "bravo"/,
    );

    await session.close();
  });
});

describe("session.skill(name, ...) name resolution", () => {
  it("resolves a string name via app.skills.get", async () => {
    const model = createTestAdapter({ defaultResponse: "ok" });
    const app = createApp(makeAgent(model), { maxTicks: 5 });

    app.skills.register(
      defineSkill({
        name: "triage",
        description: "Triage an issue.",
        instructions: "Triage now.",
      }),
    );

    const session = await app.session();

    model.respondWith([{ tool: { name: "submit", input: { fixApplied: true } } }]);

    // Pass STRING name, not SkillDef object
    const result = await session.skill("triage", {
      args: { issueNumber: 42 },
      result: z.object({ fixApplied: z.boolean() }),
    });
    expect(result).toEqual({ fixApplied: true });

    await session.close();
  });

  it("throws a clear error for unknown name", async () => {
    const model = createTestAdapter({ defaultResponse: "ok" });
    const app = createApp(makeAgent(model), { maxTicks: 5 });
    const session = await app.session();

    await expect(session.skill("nonexistent", { args: {} })).rejects.toThrow(
      /skill "nonexistent" not found/,
    );

    await session.close();
  });
});
