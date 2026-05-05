/**
 * Integration: shell injections through the skill pipeline.
 *
 * Verifies:
 * - $ substitution applies BEFORE shell execution (so commands can use $args)
 * - Substituted command runs via session.shell → mounted Bash tool
 * - Output replaces the placeholder before the model sees the body
 * - Missing Bash → loud failure (session.shell throws)
 * - Implicit `skill` tool also runs injections
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
import { createTool } from "../../tool/tool.js";

/**
 * Fake Bash tool — captures the commands it was called with and returns
 * a canned response. Not a real shell, but matches the session.shell ↔
 * dispatch("bash") contract.
 */
function makeFakeBash(): {
  tool: ReturnType<typeof createTool>;
  commands: string[];
  setResult: (text: string) => void;
} {
  const commands: string[] = [];
  let nextResult = "fake-output";
  const tool = createTool({
    name: "bash",
    description: "Fake bash for tests",
    input: z.object({ command: z.string() }),
    audience: "user",
    handler: async ({ command }) => {
      commands.push(command);
      return [{ type: "text" as const, text: nextResult }];
    },
  });
  return {
    tool,
    commands,
    setResult: (t) => {
      nextResult = t;
    },
  };
}

describe("shell injection through session.skill()", () => {
  it("$ substitution runs first, then commands fire with substituted text", async () => {
    const model = createTestAdapter({ defaultResponse: "ok" });
    const fake = makeFakeBash();

    function Agent() {
      const Bash = fake.tool;
      return (
        <>
          <Bash />
          <Model model={model} />
          <System>T</System>
          <Timeline />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();

    fake.setResult("CMD-OUTPUT");
    model.respondWith([{ tool: { name: "submit", input: { ok: true } } }]);

    const Inspect = defineSkill({
      name: "inspect",
      description: "Inspect a path.",
      instructions: "Listing for $path:\n!`ls -la $path`\nDone.",
      input: z.object({ path: z.string() }),
    });

    await session.skill(Inspect, {
      args: { path: "/tmp" },
      result: z.object({ ok: z.boolean() }),
    });

    // The command actually called bash with the substituted text
    expect(fake.commands).toEqual(["ls -la /tmp"]);

    // The model saw the rendered body with the command output spliced in
    const serialized = JSON.stringify(model.getCapturedInputs());
    expect(serialized).toContain("Listing for /tmp");
    expect(serialized).toContain("CMD-OUTPUT");
    // Placeholders are gone
    expect(serialized).not.toContain("!`ls -la");
    expect(serialized).not.toContain("$path");
  });

  it("block-form commands also run", async () => {
    const model = createTestAdapter({ defaultResponse: "ok" });
    const fake = makeFakeBash();

    function Agent() {
      const Bash = fake.tool;
      return (
        <>
          <Bash />
          <Model model={model} />
          <System>T</System>
          <Timeline />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();

    fake.setResult("ENV-OUTPUT");
    model.respondWith([{ tool: { name: "submit", input: { ok: true } } }]);

    const EnvSkill = defineSkill({
      name: "env",
      description: "Show env.",
      instructions: ["## Env", "```!", "node --version", "git status --short", "```"].join("\n"),
      input: z.object({}),
    });

    await session.skill(EnvSkill, {
      args: {},
      result: z.object({ ok: z.boolean() }),
    });

    // Single multi-line command was passed as one bash invocation
    expect(fake.commands).toEqual(["node --version\ngit status --short"]);

    const serialized = JSON.stringify(model.getCapturedInputs());
    expect(serialized).toContain("ENV-OUTPUT");
    expect(serialized).not.toContain("```!");
  });

  it("throws loudly when no Bash tool is mounted (session.shell rejects)", async () => {
    const model = createTestAdapter({ defaultResponse: "ok" });

    // Notice: no Bash tool in the tree
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

    const NeedsShell = defineSkill({
      name: "needs-shell",
      description: "Needs a shell.",
      instructions: "Diff: !`git diff`",
      input: z.object({}),
    });

    await expect(
      session.skill(NeedsShell, {
        args: {},
        result: z.object({ ok: z.boolean() }),
      }),
    ).rejects.toThrow(
      /Skill shell injection failed.*git diff.*requires a <Bash> tool to be mounted/s,
    );
  });
});

describe("shell injection through the implicit `skill` tool", () => {
  it("model loading a skill via dispatch sees command output", async () => {
    const model = createTestAdapter({ defaultResponse: "ok" });
    const fake = makeFakeBash();

    function Agent() {
      const Bash = fake.tool;
      return (
        <>
          <Bash />
          <Model model={model} />
          <System>T</System>
          <Timeline />
        </>
      );
    }

    const app = createApp(Agent, { maxTicks: 5 });
    app.skills.register(
      defineSkill({
        name: "summarize-changes",
        description: "Summarize uncommitted changes.",
        instructions: "## Diff\n!`git diff HEAD`\n",
      }),
    );

    const session = await app.session();
    await session.mount();

    fake.setResult("DIFF-OUTPUT");
    const result = await session.dispatch("skill", {
      name: "summarize-changes",
    });

    const text = (result[0] as any).text;
    expect(text).toContain("DIFF-OUTPUT");
    expect(text).not.toContain("!`git diff");
    expect(fake.commands).toEqual(["git diff HEAD"]);

    await session.close();
  });
});
