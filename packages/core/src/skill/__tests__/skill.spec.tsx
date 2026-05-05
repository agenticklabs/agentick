/**
 * defineSkill + session.skill() tests.
 *
 * The skill defines the workflow (instructions + input + tools). The caller
 * decides the result shape at invocation time via opts.result.
 *
 * Verifies:
 * - defineSkill validates name + instructions
 * - session.skill returns typed output when caller passes a result schema
 * - Args validated against skill.input
 * - Result validated against caller's result schema
 * - maxTicks failure when model never submits (only when result schema given)
 * - Without result schema: skill returns final assistant text (free-form)
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

// ============================================================================
// defineSkill
// ============================================================================

describe("defineSkill", () => {
  it("returns the def when valid (no output schema needed)", () => {
    const Triage = defineSkill({
      name: "triage",
      description: "Triage an issue.",
      instructions: "Triage the issue.",
      input: z.object({ issueNumber: z.number() }),
    });
    expect(Triage.name).toBe("triage");
    // No output field — caller provides result at invocation
    expect((Triage as any).output).toBeUndefined();
  });

  it("input is optional", () => {
    const Free = defineSkill({
      name: "free",
      description: "Do whatever.",
      instructions: "Do whatever.",
    });
    expect(Free.input).toBeUndefined();
  });

  // Helper for validation tests — fills in the required fields with valid defaults
  const desc = "A test skill description.";

  it("throws when name is missing or invalid (per Agent Skills spec)", () => {
    expect(() => defineSkill({ name: "" as any, description: desc, instructions: "x" })).toThrow(
      /non-empty string/,
    );
    expect(() =>
      defineSkill({ name: "has spaces" as any, description: desc, instructions: "x" }),
    ).toThrow(/invalid|name must match/i);
    expect(() =>
      defineSkill({ name: "Camel-Case" as any, description: desc, instructions: "x" }),
    ).toThrow(/invalid/);
    expect(() =>
      defineSkill({ name: "snake_case" as any, description: desc, instructions: "x" }),
    ).toThrow(/invalid/);
    expect(() => defineSkill({ name: "-leading", description: desc, instructions: "x" })).toThrow(
      /invalid/,
    );
    expect(() =>
      defineSkill({ name: "double--hyphen", description: desc, instructions: "x" }),
    ).toThrow(/invalid/);
    expect(() =>
      defineSkill({ name: "a".repeat(65), description: desc, instructions: "x" }),
    ).toThrow(/exceeds 64/);
  });

  it("accepts spec-valid names", () => {
    expect(() =>
      defineSkill({ name: "pdf-processing", description: desc, instructions: "x" }),
    ).not.toThrow();
    expect(() => defineSkill({ name: "a", description: desc, instructions: "x" })).not.toThrow();
    expect(() =>
      defineSkill({ name: "skill-1", description: desc, instructions: "x" }),
    ).not.toThrow();
    expect(() =>
      defineSkill({ name: "1skill", description: desc, instructions: "x" }),
    ).not.toThrow();
  });

  it("requires non-empty description (per spec)", () => {
    expect(() => defineSkill({ name: "x", description: "" as any, instructions: "y" })).toThrow(
      /non-empty description/,
    );
    expect(() => defineSkill({ name: "x", instructions: "y" } as any)).toThrow(
      /non-empty description/,
    );
  });

  it("validates description length (≤1024 per spec)", () => {
    expect(() =>
      defineSkill({
        name: "x",
        description: "a".repeat(1025),
        instructions: "y",
      }),
    ).toThrow(/exceeds 1024/);
  });

  it("validates compatibility length (≤500 per spec)", () => {
    expect(() =>
      defineSkill({
        name: "x",
        description: desc,
        instructions: "y",
        compatibility: "a".repeat(501),
      }),
    ).toThrow(/exceeds 500/);
  });

  it("validates metadata values are strings (per spec)", () => {
    expect(() =>
      defineSkill({
        name: "x",
        description: desc,
        instructions: "y",
        metadata: { author: "ok", version: 1 } as any,
      }),
    ).toThrow(/metadata\.version must be a string/);

    // Strings pass
    expect(() =>
      defineSkill({
        name: "x",
        description: desc,
        instructions: "y",
        metadata: { author: "example", version: "1.0" },
      }),
    ).not.toThrow();
  });

  it("throws when instructions are empty", () => {
    expect(() => defineSkill({ name: "x", description: desc, instructions: "   " })).toThrow(
      /non-empty instructions/,
    );
  });
});

// ============================================================================
// session.skill — typed result (caller passes result schema)
// ============================================================================

describe("session.skill — with result schema", () => {
  it("returns typed result when model calls submit", async () => {
    const model = createTestAdapter({ defaultResponse: "ok" });
    function Agent() {
      return (
        <>
          <Model model={model} />
          <System>Test</System>
          <Timeline />
        </>
      );
    }
    const app = createApp(Agent, { maxTicks: 5 });
    const session = await app.session();

    // Test model calls submit with the structured result
    model.respondWith([{ tool: { name: "submit", input: { fixApplied: true } } }]);

    const Triage = defineSkill({
      name: "triage",
      description: "Triage an issue.",
      instructions: "Triage the issue.",
      input: z.object({ issueNumber: z.number() }),
    });

    const result = await session.skill(Triage, {
      args: { issueNumber: 42 },
      result: z.object({ fixApplied: z.boolean() }),
    });

    expect(result).toEqual({ fixApplied: true });

    await session.close();
  });

  it("validates args against skill.input", async () => {
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

    const Triage = defineSkill({
      name: "triage",
      description: "Triage.",
      instructions: "x",
      input: z.object({ issueNumber: z.number() }),
    });

    await expect(
      session.skill(Triage, {
        args: { issueNumber: "not a number" } as any,
        result: z.object({ ok: z.boolean() }),
      }),
    ).rejects.toThrow(
      "Validation failed: issueNumber: Invalid input: expected number, received string",
    );

    await session.close();
  });

  it("validates result against caller's result schema (rejects bad shape)", async () => {
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

    // Model submits the wrong shape — result validation rejects
    model.respondWith([{ tool: { name: "submit", input: { fixApplied: "yes" as any } } }]);

    const Triage = defineSkill({
      name: "triage",
      description: "Triage.",
      instructions: "x",
      input: z.object({ issueNumber: z.number() }),
    });

    await expect(
      session.skill(Triage, {
        args: { issueNumber: 1 },
        result: z.object({ fixApplied: z.boolean() }),
      }),
    ).rejects.toThrow(
      "Validation failed: fixApplied: Invalid input: expected boolean, received string",
    );

    await session.close();
  });

  it("throws when model never calls submit within maxTicks", async () => {
    const model = createTestAdapter({ defaultResponse: "still thinking" });
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

    const Triage = defineSkill({
      name: "triage",
      description: "Triage with low maxTicks.",
      instructions: "x",
      input: z.object({ issueNumber: z.number() }),
      maxTicks: 1,
    });

    await expect(
      session.skill(Triage, {
        args: { issueNumber: 1 },
        result: z.object({ fixApplied: z.boolean() }),
      }),
    ).rejects.toThrow(/did not call submit/);

    await session.close();
  });

  it("same skill, different result schemas — different typed outputs", async () => {
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

    const Triage = defineSkill({
      name: "triage",
      description: "Triage an issue.",
      instructions: "Triage.",
      input: z.object({ issueNumber: z.number() }),
    });

    // Caller A wants { fixApplied: boolean }
    model.respondWith([{ tool: { name: "submit", input: { fixApplied: true } } }]);
    const a = await session.skill(Triage, {
      args: { issueNumber: 1 },
      result: z.object({ fixApplied: z.boolean() }),
    });
    expect(a).toEqual({ fixApplied: true });

    // Same skill, caller B wants { severity: "high"|"low" }
    model.respondWith([{ tool: { name: "submit", input: { severity: "high" } } }]);
    const b = await session.skill(Triage, {
      args: { issueNumber: 1 },
      result: z.object({ severity: z.enum(["low", "high"]) }),
    });
    expect(b).toEqual({ severity: "high" });

    await session.close();
  });
});

// ============================================================================
// session.skill — free-form (no result schema)
// ============================================================================

describe("session.skill — without result schema", () => {
  it("returns final assistant text when no result schema is given", async () => {
    const model = createTestAdapter({ defaultResponse: "Here is your summary." });
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

    const Summarize = defineSkill({
      name: "summarize",
      description: "Summarize content.",
      instructions: "Summarize the input.",
      input: z.object({ text: z.string() }),
    });

    const summary = await session.skill(Summarize, {
      args: { text: "Long content here" },
    });

    expect(typeof summary).toBe("string");
    expect(summary).toContain("summary");

    await session.close();
  });
});
