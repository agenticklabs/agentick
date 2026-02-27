/**
 * Unit tests for mergeStructuralInput
 *
 * Pure function tests — no mocks, no React, no sessions.
 */

import { describe, it, expect } from "vitest";
import { mergeStructuralInput, type StructuralInput } from "../merge-structural-input.js";
import { createEmptyCompiledStructure } from "../types.js";
import type { CompiledStructure, CompiledSection } from "../types.js";

function empty(): CompiledStructure {
  return createEmptyCompiledStructure();
}

describe("mergeStructuralInput", () => {
  // =========================================================================
  // system
  // =========================================================================

  describe("system", () => {
    it("appends system strings as CompiledTimelineEntry with role 'system'", () => {
      const compiled = empty();
      mergeStructuralInput(compiled, { system: ["You are helpful.", "Be concise."] });

      expect(compiled.systemEntries).toHaveLength(2);
      expect(compiled.systemEntries[0]!.role).toBe("system");
      expect(compiled.systemEntries[0]!.content).toEqual([
        { type: "text", text: "You are helpful." },
      ]);
      expect(compiled.systemEntries[0]!.renderer).toBeNull();
      expect(compiled.systemEntries[1]!.content).toEqual([{ type: "text", text: "Be concise." }]);
    });

    it("appends after existing system entries", () => {
      const compiled = empty();
      compiled.systemEntries.push({
        role: "system",
        content: [{ type: "text", text: "existing" } as any],
        renderer: null,
      });

      mergeStructuralInput(compiled, { system: ["new"] });
      expect(compiled.systemEntries).toHaveLength(2);
      expect(compiled.systemEntries[1]!.content).toEqual([{ type: "text", text: "new" }]);
    });
  });

  // =========================================================================
  // grounding
  // =========================================================================

  describe("grounding", () => {
    it("creates CompiledEphemeral at 'start' with _grounding metadata", () => {
      const compiled = empty();
      mergeStructuralInput(compiled, {
        grounding: [{ title: "Context", audience: "model", content: "Some context" }],
      });

      expect(compiled.ephemeral).toHaveLength(1);
      const e = compiled.ephemeral[0]!;
      expect(e.position).toBe("start");
      expect(e.order).toBe(0);
      expect(e.renderer).toBeNull();
      expect(e.metadata).toEqual({
        _grounding: { audience: "model", title: "Context" },
      });
    });

    it("normalizes string content to text block", () => {
      const compiled = empty();
      mergeStructuralInput(compiled, {
        grounding: [{ content: "Hello world" }],
      });

      expect(compiled.ephemeral[0]!.content).toEqual([{ type: "text", text: "Hello world" }]);
    });

    it("passes through ContentBlock[] content", () => {
      const blocks = [
        { type: "text" as const, text: "block1" },
        { type: "text" as const, text: "block2" },
      ];
      const compiled = empty();
      mergeStructuralInput(compiled, {
        grounding: [{ content: blocks }],
      });

      expect(compiled.ephemeral[0]!.content).toEqual(blocks);
    });

    it("defaults audience to 'model' and position to 'start'", () => {
      const compiled = empty();
      mergeStructuralInput(compiled, { grounding: [{ content: "test" }] });

      const e = compiled.ephemeral[0]!;
      expect(e.position).toBe("start");
      expect(e.metadata!._grounding).toEqual({ audience: "model", title: undefined });
    });

    it("respects custom position and order", () => {
      const compiled = empty();
      mergeStructuralInput(compiled, {
        grounding: [{ content: "test", position: "before-user", order: 5 }],
      });

      expect(compiled.ephemeral[0]!.position).toBe("before-user");
      expect(compiled.ephemeral[0]!.order).toBe(5);
    });

    it("merges entry metadata with _grounding metadata", () => {
      const compiled = empty();
      mergeStructuralInput(compiled, {
        grounding: [{ content: "test", metadata: { source: "api" }, title: "API" }],
      });

      expect(compiled.ephemeral[0]!.metadata).toEqual({
        source: "api",
        _grounding: { audience: "model", title: "API" },
      });
    });
  });

  // =========================================================================
  // sections
  // =========================================================================

  describe("sections", () => {
    it("adds section to sections map", () => {
      const compiled = empty();
      mergeStructuralInput(compiled, {
        sections: [{ id: "rules", title: "Rules", content: "Be nice." }],
      });

      expect(compiled.sections.has("rules")).toBe(true);
      const section = compiled.sections.get("rules")!;
      expect(section.title).toBe("Rules");
      expect(section.content).toEqual([{ type: "text", text: "Be nice." }]);
      expect(section.renderer).toBeNull();
    });

    it("skips section if ID already exists (JSX wins)", () => {
      const compiled = empty();
      const existing: CompiledSection = {
        id: "rules",
        title: "JSX Rules",
        content: [{ type: "text", text: "JSX content" } as any],
        renderer: null,
      };
      compiled.sections.set("rules", existing);

      mergeStructuralInput(compiled, {
        sections: [{ id: "rules", title: "Input Rules", content: "Input content" }],
      });

      expect(compiled.sections.get("rules")!.title).toBe("JSX Rules");
    });

    it("generates ID when not provided", () => {
      const compiled = empty();
      mergeStructuralInput(compiled, {
        sections: [{ title: "Auto", content: "auto content" }],
      });

      expect(compiled.sections.size).toBe(1);
      const key = [...compiled.sections.keys()][0]!;
      expect(key).toMatch(/^structural-section-/);
    });

    it("preserves audience, visibility, tags, and metadata", () => {
      const compiled = empty();
      mergeStructuralInput(compiled, {
        sections: [
          {
            id: "s1",
            audience: "model",
            visibility: "observer",
            tags: ["tag1"],
            metadata: { key: "value" },
            content: "test",
          },
        ],
      });

      const section = compiled.sections.get("s1")!;
      expect(section.audience).toBe("model");
      expect(section.visibility).toBe("observer");
      expect(section.tags).toEqual(["tag1"]);
      expect(section.metadata).toEqual({ key: "value" });
    });
  });

  // =========================================================================
  // ephemeral
  // =========================================================================

  describe("ephemeral", () => {
    it("appends ephemeral entries with position and order preserved", () => {
      const compiled = empty();
      mergeStructuralInput(compiled, {
        ephemeral: [
          { content: "first", position: "start", order: 1 },
          { content: "second", position: "before-user", order: 2 },
        ],
      });

      expect(compiled.ephemeral).toHaveLength(2);
      expect(compiled.ephemeral[0]!.position).toBe("start");
      expect(compiled.ephemeral[0]!.order).toBe(1);
      expect(compiled.ephemeral[1]!.position).toBe("before-user");
      expect(compiled.ephemeral[1]!.order).toBe(2);
    });

    it("defaults position to 'end' and order to 0", () => {
      const compiled = empty();
      mergeStructuralInput(compiled, {
        ephemeral: [{ content: "test" }],
      });

      expect(compiled.ephemeral[0]!.position).toBe("end");
      expect(compiled.ephemeral[0]!.order).toBe(0);
    });

    it("normalizes string content", () => {
      const compiled = empty();
      mergeStructuralInput(compiled, {
        ephemeral: [{ content: "hello" }],
      });

      expect(compiled.ephemeral[0]!.content).toEqual([{ type: "text", text: "hello" }]);
    });

    it("preserves metadata", () => {
      const compiled = empty();
      mergeStructuralInput(compiled, {
        ephemeral: [{ content: "test", metadata: { source: "input" } }],
      });

      expect(compiled.ephemeral[0]!.metadata).toEqual({ source: "input" });
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe("edge cases", () => {
    it("undefined/empty fields are no-op", () => {
      const compiled = empty();
      mergeStructuralInput(compiled, {});

      expect(compiled.systemEntries).toHaveLength(0);
      expect(compiled.ephemeral).toHaveLength(0);
      expect(compiled.sections.size).toBe(0);
    });

    it("undefined individual fields are no-op", () => {
      const compiled = empty();
      mergeStructuralInput(compiled, {
        system: undefined,
        grounding: undefined,
        sections: undefined,
        ephemeral: undefined,
      });

      expect(compiled.systemEntries).toHaveLength(0);
      expect(compiled.ephemeral).toHaveLength(0);
      expect(compiled.sections.size).toBe(0);
    });

    it("all fields simultaneously merge correctly", () => {
      const compiled = empty();
      const input: StructuralInput = {
        system: ["sys1"],
        grounding: [{ content: "ground1", title: "G1" }],
        sections: [{ id: "sec1", content: "section1" }],
        ephemeral: [{ content: "eph1", position: "end" }],
      };

      mergeStructuralInput(compiled, input);

      expect(compiled.systemEntries).toHaveLength(1);
      expect(compiled.ephemeral).toHaveLength(2); // grounding + ephemeral
      expect(compiled.sections.size).toBe(1);
    });

    it("multiple entries per field are appended in order", () => {
      const compiled = empty();
      mergeStructuralInput(compiled, {
        system: ["a", "b", "c"],
        grounding: [
          { content: "g1", title: "G1" },
          { content: "g2", title: "G2" },
        ],
        ephemeral: [{ content: "e1" }, { content: "e2" }, { content: "e3" }],
      });

      expect(compiled.systemEntries).toHaveLength(3);
      expect(compiled.systemEntries[0]!.content[0]).toEqual({ type: "text", text: "a" });
      expect(compiled.systemEntries[2]!.content[0]).toEqual({ type: "text", text: "c" });

      // 2 grounding + 3 ephemeral
      expect(compiled.ephemeral).toHaveLength(5);
    });

    it("content normalization handles undefined content", () => {
      const compiled = empty();
      mergeStructuralInput(compiled, {
        ephemeral: [{ position: "start" }],
      });

      expect(compiled.ephemeral[0]!.content).toEqual([]);
    });
  });
});
