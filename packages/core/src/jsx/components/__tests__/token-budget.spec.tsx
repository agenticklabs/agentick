/**
 * Timeline Token Budget Tests
 *
 * Tests token budget compaction when using Timeline's maxTokens prop.
 * Covers: compaction strategies, headroom, eviction callbacks, custom
 * strategies, token fallback, and edge cases.
 *
 * @jsxImportSource react
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { FiberCompiler } from "../../../compiler/fiber-compiler";
import {
  createMockCom,
  createMockTickState,
  makeTimelineEntry,
  makeCOMInput,
} from "../../../testing";
import { Timeline } from "../timeline";
import type { COMTimelineEntry } from "../../../com/types";
import type { TokenBudgetInfo } from "../token-budget";

const h = React.createElement;

// ============================================================================
// Helpers
// ============================================================================

// Re-export core helpers with short aliases for readability
const makeEntry = makeTimelineEntry;
const makePrevious = makeCOMInput;

describe("Timeline token budget", () => {
  let ctx: ReturnType<typeof createMockCom>;
  let compiler: FiberCompiler;

  beforeEach(() => {
    ctx = createMockCom();
    compiler = new FiberCompiler(ctx);
  });

  /** Compile a Timeline with budget props and given entries in tick state. */
  async function compileWithBudget(
    entries: COMTimelineEntry[],
    budgetProps: Record<string, unknown>,
  ) {
    const tickState = createMockTickState({
      previous: makePrevious(entries),
      timeline: entries,
    });
    const App = () => h(Timeline, { maxTokens: 100, ...budgetProps });
    return compiler.compile(h(App), tickState);
  }

  // ============================================================================
  // Pass-through (within budget)
  // ============================================================================

  describe("within budget", () => {
    it("passes all entries when total tokens fit", async () => {
      const entries = [makeEntry("user", "Hello", 10), makeEntry("assistant", "World", 10)];
      const compiled = await compileWithBudget(entries, { maxTokens: 100 });

      expect(compiled.timelineEntries).toHaveLength(2);
    });

    it("passes all entries with strategy='none'", async () => {
      const entries = [
        makeEntry("user", "Hello", 50),
        makeEntry("assistant", "World", 50),
        makeEntry("user", "More", 50),
      ];
      // Total 150 tokens, budget 100, but strategy=none → no compaction
      const compiled = await compileWithBudget(entries, { maxTokens: 100, strategy: "none" });

      expect(compiled.timelineEntries).toHaveLength(3);
    });

    it("passes through when entries exactly fit budget", async () => {
      const entries = [makeEntry("user", "First", 50), makeEntry("assistant", "Second", 50)];
      const compiled = await compileWithBudget(entries, { maxTokens: 100 });

      expect(compiled.timelineEntries).toHaveLength(2);
    });

    it("passes all entries when maxTokens is not set", async () => {
      const entries = [makeEntry("user", "Hello", 500), makeEntry("assistant", "World", 500)];
      const tickState = createMockTickState({
        previous: makePrevious(entries),
        timeline: entries,
      });
      // No maxTokens — no compaction
      const App = () => h(Timeline);
      const compiled = await compiler.compile(h(App), tickState);

      expect(compiled.timelineEntries).toHaveLength(2);
    });
  });

  // ============================================================================
  // Truncate strategy
  // ============================================================================

  describe("truncate strategy", () => {
    it("keeps newest entries that fit", async () => {
      const entries = [
        makeEntry("user", "Old message", 50),
        makeEntry("assistant", "Middle message", 50),
        makeEntry("user", "Newest message", 50),
      ];
      // Budget 60: only the newest entry fits (50 tokens)
      const compiled = await compileWithBudget(entries, { maxTokens: 60, strategy: "truncate" });

      expect(compiled.timelineEntries).toHaveLength(1);
      const text = (compiled.timelineEntries[0].content[0] as any).text;
      expect(text).toBe("Newest message");
    });

    it("evicts oldest entries first", async () => {
      const entries = [
        makeEntry("user", "First", 30),
        makeEntry("assistant", "Second", 30),
        makeEntry("user", "Third", 30),
      ];
      // Budget 65: two newest fit (30+30=60 ≤ 65)
      const compiled = await compileWithBudget(entries, { maxTokens: 65, strategy: "truncate" });

      expect(compiled.timelineEntries).toHaveLength(2);
      const texts = compiled.timelineEntries.map((e) => (e.content[0] as any).text);
      expect(texts).toEqual(["Second", "Third"]);
    });

    it("keeps all entries when they fit", async () => {
      const entries = [makeEntry("user", "A", 10), makeEntry("assistant", "B", 10)];
      const compiled = await compileWithBudget(entries, { maxTokens: 100, strategy: "truncate" });

      expect(compiled.timelineEntries).toHaveLength(2);
    });
  });

  // ============================================================================
  // Sliding window strategy
  // ============================================================================

  describe("sliding-window strategy", () => {
    it("preserves specified role entries", async () => {
      const entries = [
        makeEntry("user", "Preserved user msg", 30),
        makeEntry("assistant", "Old assistant", 30),
        makeEntry("assistant", "New assistant", 30),
      ];
      // Budget 65: preserved user (30) + remaining budget 35 → fits newest assistant (30)
      const compiled = await compileWithBudget(entries, {
        maxTokens: 65,
        strategy: "sliding-window",
        preserveRoles: ["user"],
      });

      expect(compiled.timelineEntries).toHaveLength(2);
      const texts = compiled.timelineEntries.map((e) => (e.content[0] as any).text);
      expect(texts).toContain("Preserved user msg");
      expect(texts).toContain("New assistant");
    });

    it("maintains original entry order after compaction", async () => {
      const entries = [
        makeEntry("user", "User first", 20),
        makeEntry("assistant", "Old reply", 40),
        makeEntry("assistant", "Middle reply", 40),
        makeEntry("assistant", "Newest reply", 40),
      ];
      // Budget 65, preserve user (20). Remaining 45 fits newest assistant (40) only.
      const compiled = await compileWithBudget(entries, {
        maxTokens: 65,
        strategy: "sliding-window",
        preserveRoles: ["user"],
      });

      expect(compiled.timelineEntries).toHaveLength(2);
      const texts = compiled.timelineEntries.map((e) => (e.content[0] as any).text);
      expect(texts).toEqual(["User first", "Newest reply"]);
    });

    it("defaults to preserving system role", async () => {
      const entries = [
        makeEntry("user", "Old user", 40),
        makeEntry("assistant", "Old assistant", 40),
        makeEntry("user", "New user", 40),
      ];
      // Budget 50, default preserveRoles=["system"] → no entries preserved
      // All 3 are candidates, newest first: "New user" (40) fits, rest evicted
      const compiled = await compileWithBudget(entries, { maxTokens: 50 });

      expect(compiled.timelineEntries).toHaveLength(1);
      const text = (compiled.timelineEntries[0].content[0] as any).text;
      expect(text).toBe("New user");
    });
  });

  // ============================================================================
  // Headroom
  // ============================================================================

  describe("headroom", () => {
    it("reduces effective budget by headroom amount", async () => {
      const entries = [makeEntry("user", "Message A", 40), makeEntry("assistant", "Message B", 40)];
      // maxTokens 100, headroom 30 → effective budget 70
      // Total 80 > 70, so compaction kicks in
      // Truncate: newest (40) fits in 70, oldest evicted
      const compiled = await compileWithBudget(entries, {
        maxTokens: 100,
        headroom: 30,
        strategy: "truncate",
      });

      expect(compiled.timelineEntries).toHaveLength(1);
      const text = (compiled.timelineEntries[0].content[0] as any).text;
      expect(text).toBe("Message B");
    });

    it("zero headroom does not affect budget", async () => {
      const entries = [makeEntry("user", "A", 40), makeEntry("assistant", "B", 40)];
      const compiled = await compileWithBudget(entries, {
        maxTokens: 100,
        headroom: 0,
        strategy: "truncate",
      });

      expect(compiled.timelineEntries).toHaveLength(2);
    });
  });

  // ============================================================================
  // onEvict callback
  // ============================================================================

  describe("onEvict", () => {
    it("fires callback with evicted entries", async () => {
      const onEvict = vi.fn();
      const entries = [makeEntry("user", "Evicted", 60), makeEntry("assistant", "Kept", 40)];
      await compileWithBudget(entries, {
        maxTokens: 50,
        strategy: "truncate",
        onEvict,
      });

      expect(onEvict).toHaveBeenCalledTimes(1);
      expect(onEvict).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.objectContaining({
              content: expect.arrayContaining([expect.objectContaining({ text: "Evicted" })]),
            }),
          }),
        ]),
      );
    });

    it("does not fire when no eviction needed", async () => {
      const onEvict = vi.fn();
      const entries = [makeEntry("user", "Fits", 10)];
      await compileWithBudget(entries, { maxTokens: 100, onEvict });

      expect(onEvict).not.toHaveBeenCalled();
    });

    it("does not fire with empty timeline", async () => {
      const onEvict = vi.fn();
      await compileWithBudget([], { maxTokens: 100, onEvict });

      expect(onEvict).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Custom strategy function
  // ============================================================================

  describe("custom strategy", () => {
    it("calls custom function with entries and budget info", async () => {
      const customStrategy = vi.fn(
        (entries: COMTimelineEntry[], _budget: { maxTokens: number; currentTokens: number }) => ({
          kept: [entries[0]],
          evicted: entries.slice(1),
        }),
      );

      const entries = [
        makeEntry("user", "First", 20),
        makeEntry("assistant", "Second", 20),
        makeEntry("user", "Third", 20),
      ];
      // Total 60 tokens, budget 50 → triggers compaction
      const compiled = await compileWithBudget(entries, {
        maxTokens: 50,
        strategy: customStrategy,
      });

      expect(customStrategy).toHaveBeenCalledTimes(1);
      expect(customStrategy).toHaveBeenCalledWith(
        entries,
        expect.objectContaining({ maxTokens: 50, currentTokens: 60 }),
        undefined,
      );
      expect(compiled.timelineEntries).toHaveLength(1);
      expect((compiled.timelineEntries[0].content[0] as any).text).toBe("First");
    });

    it("passes guidance to custom function", async () => {
      const customStrategy = vi.fn((entries: COMTimelineEntry[]) => ({
        kept: entries,
        evicted: [],
      }));

      const entries = [makeEntry("user", "Hello", 60)];
      await compileWithBudget(entries, {
        maxTokens: 50,
        strategy: customStrategy,
        guidance: "Keep important messages",
      });

      expect(customStrategy).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "Keep important messages",
      );
    });
  });

  // ============================================================================
  // Token fallback (no .tokens field)
  // ============================================================================

  describe("token fallback", () => {
    it("uses char/4 fallback when .tokens is missing", async () => {
      const entries = [
        makeEntry("user", "Hello", undefined),
        makeEntry("assistant", "World", undefined),
      ];
      // With char/4 fallback, each is ~6 tokens. Budget 20 → both fit
      const compiled = await compileWithBudget(entries, { maxTokens: 20, strategy: "truncate" });

      expect(compiled.timelineEntries).toHaveLength(2);
    });

    it("uses .tokens field when available", async () => {
      const entries = [
        makeEntry("user", "Short text", 500),
        makeEntry("assistant", "Also short", 10),
      ];
      // Budget 50: with .tokens, first entry is 500 (way over), second is 10
      const compiled = await compileWithBudget(entries, { maxTokens: 50, strategy: "truncate" });

      expect(compiled.timelineEntries).toHaveLength(1);
      expect((compiled.timelineEntries[0].content[0] as any).text).toBe("Also short");
    });
  });

  // ============================================================================
  // Edge cases
  // ============================================================================

  describe("edge cases", () => {
    it("handles empty timeline", async () => {
      const compiled = await compileWithBudget([], { maxTokens: 100 });
      expect(compiled.timelineEntries).toHaveLength(0);
    });

    it("handles single entry over budget", async () => {
      const entries = [makeEntry("user", "Big message", 200)];
      const compiled = await compileWithBudget(entries, { maxTokens: 50, strategy: "truncate" });

      expect(compiled.timelineEntries).toHaveLength(0);
    });

    it("handles all entries with same token count", async () => {
      const entries = [
        makeEntry("user", "A", 25),
        makeEntry("assistant", "B", 25),
        makeEntry("user", "C", 25),
        makeEntry("assistant", "D", 25),
      ];
      // Budget 55: truncate → newest first: D(25), C(25)=50 ≤ 55, then B(25)=75>55
      const compiled = await compileWithBudget(entries, { maxTokens: 55, strategy: "truncate" });

      expect(compiled.timelineEntries).toHaveLength(2);
      const texts = compiled.timelineEntries.map((e) => (e.content[0] as any).text);
      expect(texts).toEqual(["C", "D"]);
    });
  });

  // ============================================================================
  // Render prop budget info surfacing
  // ============================================================================

  describe("render prop budget info", () => {
    it("passes budget info as third argument to render function", async () => {
      let capturedBudget: TokenBudgetInfo | null = null;

      const entries = [makeEntry("user", "Old", 60), makeEntry("assistant", "New", 40)];
      const tickState = createMockTickState({
        previous: makePrevious(entries),
        timeline: entries,
      });

      const renderFn = vi.fn(
        (history: COMTimelineEntry[], _pending: unknown, budget: TokenBudgetInfo | null) => {
          capturedBudget = budget;
          // Return rendered entries
          return history.map((entry, i) =>
            h("entry", {
              key: `r-${i}`,
              kind: "message",
              message: entry.message,
            }),
          );
        },
      );

      const App = () => h(Timeline, { maxTokens: 50, strategy: "truncate" }, renderFn);
      await compiler.compile(h(App), tickState);

      expect(renderFn).toHaveBeenCalled();
      expect(capturedBudget).not.toBeNull();
      expect(capturedBudget!.maxTokens).toBe(50);
      expect(capturedBudget!.isCompacted).toBe(true);
      expect(capturedBudget!.evictedCount).toBe(1);
      expect(capturedBudget!.currentTokens).toBe(40);
      expect(capturedBudget!.effectiveBudget).toBe(50);
    });

    it("passes null budget when maxTokens is not set", async () => {
      let capturedBudget: TokenBudgetInfo | null | undefined = undefined;

      const entries = [makeEntry("user", "Hello", 10)];
      const tickState = createMockTickState({
        previous: makePrevious(entries),
        timeline: entries,
      });

      const renderFn = vi.fn(
        (_history: COMTimelineEntry[], _pending: unknown, budget: TokenBudgetInfo | null) => {
          capturedBudget = budget;
          return null;
        },
      );

      const App = () => h(Timeline, {}, renderFn);
      await compiler.compile(h(App), tickState);

      expect(renderFn).toHaveBeenCalled();
      expect(capturedBudget).toBeNull();
    });

    it("budget reflects headroom in effectiveBudget", async () => {
      let capturedBudget: TokenBudgetInfo | null = null;

      const entries = [makeEntry("user", "Hello", 30), makeEntry("assistant", "World", 30)];
      const tickState = createMockTickState({
        previous: makePrevious(entries),
        timeline: entries,
      });

      const renderFn = vi.fn(
        (_history: COMTimelineEntry[], _pending: unknown, budget: TokenBudgetInfo | null) => {
          capturedBudget = budget;
          return null;
        },
      );

      const App = () => h(Timeline, { maxTokens: 100, headroom: 20 }, renderFn);
      await compiler.compile(h(App), tickState);

      expect(capturedBudget).not.toBeNull();
      expect(capturedBudget!.maxTokens).toBe(100);
      expect(capturedBudget!.effectiveBudget).toBe(80);
      expect(capturedBudget!.isCompacted).toBe(false);
    });
  });

  // ============================================================================
  // Full pipeline: token estimation → compaction
  // ============================================================================

  describe("pipeline integration", () => {
    it("uses .tokens from estimation when available for compaction", async () => {
      // Entry with explicit .tokens that differ from char/4 fallback
      // "Short text" is 10 chars → char/4 would be ~7 tokens
      // But we mark it as 500 tokens — compaction should use 500
      const entries = [
        makeEntry("user", "Short text", 500),
        makeEntry("assistant", "Also short", 10),
      ];
      const compiled = await compileWithBudget(entries, { maxTokens: 50, strategy: "truncate" });

      // Only the 10-token entry fits
      expect(compiled.timelineEntries).toHaveLength(1);
      expect((compiled.timelineEntries[0].content[0] as any).text).toBe("Also short");
    });

    it("compacts entries annotated by the collector", async () => {
      // Use a custom estimator on the COM so the compiler annotates entries
      const customCtx = createMockCom();
      // Each char = 1 token (simple, predictable)
      (customCtx as any).getTokenEstimator = () => (text: string) => text.length;

      const customCompiler = new FiberCompiler(customCtx);

      // Compile an app that renders entries, then compiles a timeline on tick 2
      // For simplicity, just test that pre-annotated entries work with budget
      const entries = [
        makeEntry("user", "AAAAAAAAAA", 10), // 10 tokens
        makeEntry("assistant", "BBBBBBBBBB", 10), // 10 tokens
        makeEntry("user", "CCCCCCCCCC", 10), // 10 tokens
      ];
      // Budget 25: newest two fit (10+10=20 ≤ 25)
      const tickState = createMockTickState({
        previous: makePrevious(entries),
        timeline: entries,
      });

      const App = () => h(Timeline, { maxTokens: 25, strategy: "truncate" });
      const compiled = await customCompiler.compile(h(App), tickState);

      expect(compiled.timelineEntries).toHaveLength(2);
      const texts = compiled.timelineEntries.map((e) => (e.content[0] as any).text);
      expect(texts).toEqual(["BBBBBBBBBB", "CCCCCCCCCC"]);
    });
  });
});
