/**
 * `createApp({ skills, prompts })` — the extension-installed namespace slots
 * are LIVE (ADR 93 D3's app-side arm).
 *
 * The slot registry's `toExtension` arms mint the installs, and the app
 * spreads them BEFORE the adopter's `extensions: []` — so a slot value
 * actually installs (it used to be forwarded into `SessionDefaults` and
 * dropped on the floor), and an explicit `withX(...)` still overrides the
 * slot (namespace registration is last-writer-wins: the escape hatch
 * outranks the sugar).
 *
 * @verifiedBy this file
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { createApp } from "../react.js";
import { defineSkills, hydrateFrom, withSkills } from "@agentick/skills";
import { definePrompts, hydrateFrom as hydratePromptsFrom } from "@agentick/prompts";

const Agent = (): React.ReactElement =>
  React.createElement("message", { role: "system" }, "slot host");

const reviewSkill = {
  name: "review",
  description: "Review a change and decide.",
  content: "You are a code reviewer.",
};

const shadowSkill = {
  name: "shadow",
  description: "Proof that the explicit extension won.",
  content: "Installed by withSkills, not the slot.",
};

describe("createApp namespace slots — extension-installed arms (ADR 93 D3)", () => {
  it("a `skills:` slot value INSTALLS — the session sees the seeded library", async () => {
    const app = await createApp(React.createElement(Agent), {
      skills: defineSkills({ hydrate: hydrateFrom([reviewSkill]) }),
    });
    const session = await app.createSession({ sessionId: "s-slot-skills" });

    expect(session.skills).toBeDefined();
    expect(session.skills!.get("review")?.description).toBe("Review a change and decide.");
    await session.close();
    await app.close();
  });

  it("a `prompts:` slot value installs the same way", async () => {
    const app = await createApp(React.createElement(Agent), {
      prompts: definePrompts({
        hydrate: hydratePromptsFrom([
          { declaration: { name: "greet", description: "greeting", template: "Hello, {{name}}." } },
        ]),
      }),
    });
    const session = await app.createSession({ sessionId: "s-slot-prompts" });

    expect(session.prompts).toBeDefined();
    expect(session.prompts!.get("greet")).toBeDefined();
    await session.close();
    await app.close();
  });

  it("an explicit withSkills(...) in `extensions:` OVERRIDES the slot", async () => {
    const app = await createApp(React.createElement(Agent), {
      skills: defineSkills({ hydrate: hydrateFrom([reviewSkill]) }),
      extensions: [withSkills({ hydrate: hydrateFrom([shadowSkill]) })],
    });
    const session = await app.createSession({ sessionId: "s-slot-override" });

    // The explicit extension SUPPRESSES the slot's mint (same extension
    // name → the slot install is never created): the explicit library is the
    // one mounted; the slot's never surfaces, and there is no inbox address
    // collision.
    expect(session.skills!.get("shadow")).toBeDefined();
    expect(session.skills!.get("review")).toBeUndefined();
    await session.close();
    await app.close();
  });

  it("an omitted slot installs nothing — no phantom namespace", async () => {
    const app = await createApp(React.createElement(Agent), {});
    const session = await app.createSession({ sessionId: "s-slot-absent" });

    expect(session.skills).toBeUndefined();
    await session.close();
    await app.close();
  });
});
