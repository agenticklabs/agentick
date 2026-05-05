/**
 * SkillRegistry tests — register, lookup, search, loadDir, subscribe.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRegistry } from "../registry.js";
import { defineSkill } from "../skill.js";

function makeSkill(over: Partial<{ name: string; description: string }> = {}) {
  return defineSkill({
    name: over.name ?? "test-skill",
    description: over.description ?? "A test skill.",
    instructions: "Do the thing.",
  });
}

describe("SkillRegistry", () => {
  it("registers and retrieves by name", () => {
    const r = new SkillRegistry();
    const s = makeSkill();
    r.register(s);
    expect(r.get("test-skill")).toBe(s);
    expect(r.has("test-skill")).toBe(true);
    expect(r.size).toBe(1);
  });

  it("throws on duplicate registration", () => {
    const r = new SkillRegistry();
    r.register(makeSkill());
    expect(() => r.register(makeSkill())).toThrow(/already registered/);
  });

  it("replace() overwrites and reports prior existence", () => {
    const r = new SkillRegistry();
    expect(r.replace(makeSkill({ description: "v1" }))).toBe(false);
    expect(r.replace(makeSkill({ description: "v2" }))).toBe(true);
    expect(r.get("test-skill")?.description).toBe("v2");
  });

  it("unregister and clear", () => {
    const r = new SkillRegistry();
    r.register(makeSkill({ name: "a" }));
    r.register(makeSkill({ name: "b" }));
    expect(r.unregister("a")).toBe(true);
    expect(r.unregister("a")).toBe(false);
    expect(r.size).toBe(1);
    r.clear();
    expect(r.size).toBe(0);
  });

  it("list() returns registration order", () => {
    const r = new SkillRegistry();
    r.register(makeSkill({ name: "a" }));
    r.register(makeSkill({ name: "b" }));
    r.register(makeSkill({ name: "c" }));
    expect(r.list().map((s) => s.name)).toEqual(["a", "b", "c"]);
  });
});

describe("SkillRegistry.search", () => {
  function seed(): SkillRegistry {
    const r = new SkillRegistry();
    r.register(
      defineSkill({
        name: "triage",
        description: "Investigate and decide on an issue.",
        instructions: "x",
        whenToUse: "When the user asks to look at a bug.",
        metadata: { author: "alice", category: "ops" },
      }),
    );
    r.register(
      defineSkill({
        name: "summarize",
        description: "Summarize content.",
        instructions: "x",
        metadata: { author: "bob", category: "writing" },
      }),
    );
    r.register(
      defineSkill({
        name: "plan",
        description: "Make a step-by-step plan.",
        instructions: "x",
        metadata: { author: "alice", category: "thinking" },
      }),
    );
    return r;
  }

  it("matches by name substring", () => {
    const r = seed();
    expect(r.search({ query: "tri" }).map((s) => s.name)).toEqual(["triage"]);
  });

  it("matches by description substring (case-insensitive)", () => {
    const r = seed();
    expect(r.search({ query: "PLAN" }).map((s) => s.name)).toEqual(["plan"]);
  });

  it("matches by whenToUse", () => {
    const r = seed();
    expect(r.search({ query: "bug" }).map((s) => s.name)).toEqual(["triage"]);
  });

  it("matches by metadata value", () => {
    const r = seed();
    expect(r.search({ query: "alice" }).map((s) => s.name)).toEqual(["triage", "plan"]);
  });

  it("metadata filter (exact match, AND semantics)", () => {
    const r = seed();
    expect(r.search({ metadata: { author: "alice" } }).map((s) => s.name)).toEqual([
      "triage",
      "plan",
    ]);
    expect(r.search({ metadata: { author: "alice", category: "ops" } }).map((s) => s.name)).toEqual(
      ["triage"],
    );
  });

  it("combines query + metadata (AND)", () => {
    const r = seed();
    expect(r.search({ query: "plan", metadata: { author: "alice" } }).map((s) => s.name)).toEqual([
      "plan",
    ]);
    expect(r.search({ query: "plan", metadata: { author: "bob" } }).map((s) => s.name)).toEqual([]);
  });

  it("respects limit", () => {
    const r = seed();
    expect(r.search({ query: "a", limit: 2 }).length).toBeLessThanOrEqual(2);
  });
});

describe("SkillRegistry.subscribe", () => {
  it("fires on register / replace / unregister / clear", () => {
    const r = new SkillRegistry();
    const fn = vi.fn();
    const unsub = r.subscribe(fn);

    r.register(makeSkill({ name: "a" }));
    expect(fn).toHaveBeenCalledTimes(1);

    r.replace(makeSkill({ name: "a", description: "v2" }));
    expect(fn).toHaveBeenCalledTimes(2);

    r.unregister("a");
    expect(fn).toHaveBeenCalledTimes(3);

    // clear on empty registry: no fire
    r.clear();
    expect(fn).toHaveBeenCalledTimes(3);

    // clear on non-empty: fires
    r.register(makeSkill());
    fn.mockClear();
    r.clear();
    expect(fn).toHaveBeenCalledTimes(1); // just clear (mockClear reset before register)

    unsub();
    r.register(makeSkill({ name: "b" }));
    expect(fn).toHaveBeenCalledTimes(1); // unsub means no further calls
  });
});

describe("SkillRegistry.loadDir", () => {
  it("loads each subdirectory's SKILL.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "skills-loaddir-"));
    try {
      // Two valid skill dirs
      await mkdir(join(root, "triage"));
      await writeFile(
        join(root, "triage", "SKILL.md"),
        `---
description: Triage issues.
---
Body for triage.`,
      );
      await mkdir(join(root, "plan"));
      await writeFile(
        join(root, "plan", "SKILL.md"),
        `---
description: Make a plan.
---
Body for plan.`,
      );
      // A subdir with no SKILL.md is skipped
      await mkdir(join(root, "not-a-skill"));
      // A bare .md at the root is ignored (spec is folder-based)
      await writeFile(join(root, "stray.md"), "ignored");

      const r = new SkillRegistry();
      const loaded = await r.loadDir(root);

      expect(loaded.map((s) => s.name).sort()).toEqual(["plan", "triage"]);
      expect(r.get("triage")?.description).toBe("Triage issues.");
      expect(r.get("plan")?.description).toBe("Make a plan.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
