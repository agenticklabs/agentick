/**
 * Integration: substitution applied through session.skill().
 *
 * Verifies that $ARGUMENTS / $name / ${VARS} are resolved before the
 * model sees the skill body.
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

describe("session.skill substitution end-to-end", () => {
  it("substitutes $name from object args before sending to model", async () => {
    const model = createTestAdapter({ defaultResponse: "ok" });
    function Agent() {
      return (
        <>
          <Model model={model} />
          <System>T</System>
          <Timeline />
        </>
      );
    }
    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();

    model.respondWith([{ tool: { name: "submit", input: { ok: true } } }]);

    const Triage = defineSkill({
      name: "triage",
      description: "Triage an issue on a branch.",
      instructions: "Investigate issue $issueNumber on branch $branch. Then submit.",
      input: z.object({
        issueNumber: z.number(),
        branch: z.string(),
      }),
    });

    await session.skill(Triage, {
      args: { issueNumber: 42, branch: "feat/auth" },
      result: z.object({ ok: z.boolean() }),
    });

    // The first captured input to the model should contain the substituted body
    const inputs = model.getCapturedInputs();
    const serialized = JSON.stringify(inputs);
    expect(serialized).toContain("Investigate issue 42 on branch feat/auth");
    // Make sure the literal placeholders are gone
    expect(serialized).not.toContain("$issueNumber");
    expect(serialized).not.toContain("$branch");

    await session.close();
  });

  it("appends ARGUMENTS: <value> when body has no $ARGUMENTS placeholder", async () => {
    const model = createTestAdapter({ defaultResponse: "ok" });
    function Agent() {
      return (
        <>
          <Model model={model} />
          <System>T</System>
          <Timeline />
        </>
      );
    }
    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();

    model.respondWith([{ tool: { name: "submit", input: { ok: true } } }]);

    const Free = defineSkill({
      name: "free",
      description: "Free-form skill that takes a prompt.",
      instructions: "Do whatever the user asked.",
      input: z.object({ prompt: z.string() }),
    });

    await session.skill(Free, {
      args: { prompt: "find the leak" },
      result: z.object({ ok: z.boolean() }),
    });

    const serialized = JSON.stringify(model.getCapturedInputs());
    expect(serialized).toContain("ARGUMENTS:");
    expect(serialized).toContain("find the leak");

    await session.close();
  });

  it("substitutes ${AGENTICK_SESSION_ID} into the body", async () => {
    const model = createTestAdapter({ defaultResponse: "ok" });
    function Agent() {
      return (
        <>
          <Model model={model} />
          <System>T</System>
          <Timeline />
        </>
      );
    }
    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();

    model.respondWith([{ tool: { name: "submit", input: { ok: true } } }]);

    const Logger = defineSkill({
      name: "logger",
      description: "Log activity with the session ID.",
      instructions: "Tag all logs with session ${AGENTICK_SESSION_ID}.",
      input: z.object({}),
    });

    await session.skill(Logger, {
      args: {},
      result: z.object({ ok: z.boolean() }),
    });

    const serialized = JSON.stringify(model.getCapturedInputs());
    expect(serialized).toContain(`session ${session.id}`);
    expect(serialized).not.toContain("${AGENTICK_SESSION_ID}");

    await session.close();
  });
});
