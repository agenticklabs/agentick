/**
 * `<Timeline>` — read persisted entries through the TimelineHarness and
 * re-emit them through the collect pipeline.
 */

import React from "react";
import { describe, expect, it, vi } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { extractText } from "@agentick/spec-next";
import type { HookBridges, MessageEntry, TimelineEntry } from "@agentick/spec-next";

import { ReconcilerHarness } from "@agentick/reconciler-react-next";
import { stubBridges, mockTimelineHarness } from "@agentick/reconciler-next";
import { Timeline } from "@agentick/timeline-next/react";
import {
  compactEntries,
  getEntryTokens,
  type TokenBudgetInfo,
} from "@agentick/timeline-next/react";

type MessageTimelineEntry = Extract<TimelineEntry, { kind: "message" }>;

async function makeHarness() {
  const harness = new ReconcilerHarness(
    "h_timeline",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  return harness;
}

function userEntry(id: string, text: string, ts = 0): MessageTimelineEntry {
  return {
    kind: "message",
    message: { id, role: "user", content: [{ type: "text", text }], ts },
  };
}

function assistantEntry(id: string, text: string, ts = 0): MessageTimelineEntry {
  return {
    kind: "message",
    message: { id, role: "assistant", content: [{ type: "text", text }], ts },
  };
}

function systemEntry(id: string, text: string, ts = 0): MessageTimelineEntry {
  return {
    kind: "message",
    message: { id, role: "system", content: [{ type: "text", text }], ts },
  };
}

function asMessageEntries(entries: readonly unknown[]): readonly MessageEntry[] {
  return entries.filter(
    (e): e is MessageEntry =>
      typeof e === "object" && e !== null && (e as { kind?: string }).kind === "message",
  );
}

const joinText = extractText;

// ============================================================================

describe("<Timeline> — default rendering", () => {
  it("emits one <message> per persisted entry with content passed through", async () => {
    const timeline = mockTimelineHarness([userEntry("e1", "hello"), assistantEntry("e2", "world")]);
    const bridges: HookBridges = { ...stubBridges(), timeline };
    const harness = await makeHarness();

    await harness.mount({
      mountId: "m1",
      sessionId: "s1",
      element: React.createElement(Timeline),
      bridges,
    });
    const { tree } = await harness.renderTree({ mountId: "m1", sessionId: "s1" });

    const messages = asMessageEntries(tree.context.entries);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("user");
    expect(joinText(messages[0]!.content)).toBe("hello");
    expect(messages[1]!.role).toBe("assistant");
    expect(joinText(messages[1]!.content)).toBe("world");
  });

  it("renders an empty Fragment when the timeline is empty", async () => {
    const timeline = mockTimelineHarness();
    const bridges: HookBridges = { ...stubBridges(), timeline };
    const harness = await makeHarness();

    await harness.mount({
      mountId: "m_empty",
      sessionId: "s",
      element: React.createElement(Timeline),
      bridges,
    });
    const { tree } = await harness.renderTree({ mountId: "m_empty", sessionId: "s" });

    expect(asMessageEntries(tree.context.entries)).toEqual([]);
  });
});

describe("<Timeline> — filtering", () => {
  it("restricts rendered entries by role", async () => {
    const timeline = mockTimelineHarness([
      systemEntry("s1", "you are helpful"),
      userEntry("u1", "hi"),
      assistantEntry("a1", "yo"),
    ]);
    const bridges: HookBridges = { ...stubBridges(), timeline };
    const harness = await makeHarness();

    await harness.mount({
      mountId: "m_filt",
      sessionId: "s",
      element: React.createElement(Timeline, { roles: ["user", "assistant"] }),
      bridges,
    });
    const { tree } = await harness.renderTree({ mountId: "m_filt", sessionId: "s" });

    const messages = asMessageEntries(tree.context.entries);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("limits to the newest N entries when `limit` is set", async () => {
    const entries: MessageTimelineEntry[] = [];
    for (let i = 0; i < 5; i++) entries.push(userEntry(`e${i}`, `msg-${i}`));
    const timeline = mockTimelineHarness(entries);
    const bridges: HookBridges = { ...stubBridges(), timeline };
    const harness = await makeHarness();

    await harness.mount({
      mountId: "m_lim",
      sessionId: "s",
      element: React.createElement(Timeline, { limit: 2 }),
      bridges,
    });
    const { tree } = await harness.renderTree({ mountId: "m_lim", sessionId: "s" });

    const messages = asMessageEntries(tree.context.entries);
    expect(messages).toHaveLength(2);
    expect(joinText(messages[0]!.content)).toBe("msg-3");
    expect(joinText(messages[1]!.content)).toBe("msg-4");
  });

  it("applies a custom predicate after role filtering", async () => {
    const timeline = mockTimelineHarness([
      userEntry("u1", "yes"),
      userEntry("u2", "no"),
      userEntry("u3", "yes"),
    ]);
    const bridges: HookBridges = { ...stubBridges(), timeline };
    const harness = await makeHarness();

    await harness.mount({
      mountId: "m_pred",
      sessionId: "s",
      element: React.createElement(Timeline, {
        filter: (entry) => joinText(entry.message.content) === "yes",
      }),
      bridges,
    });
    const { tree } = await harness.renderTree({ mountId: "m_pred", sessionId: "s" });

    const messages = asMessageEntries(tree.context.entries);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => joinText(m.content))).toEqual(["yes", "yes"]);
  });
});

describe("<Timeline> — render prop", () => {
  it("receives kept entries and budget info, replacing default rendering", async () => {
    const timeline = mockTimelineHarness([userEntry("u1", "hello"), assistantEntry("a1", "world")]);
    const bridges: HookBridges = { ...stubBridges(), timeline };
    const harness = await makeHarness();

    let observed: { count: number; budget: TokenBudgetInfo | null } | null = null;

    await harness.mount({
      mountId: "m_rp",
      sessionId: "s",
      element: React.createElement(Timeline, {
        children: (entries, budget) => {
          observed = { count: entries.length, budget };
          return entries.map((e) =>
            React.createElement(
              // Cast widens to accept the host-element prop shape (role).
              // Reconciler-host intrinsics aren't in React's JSX namespace.
              "message" as unknown as React.ComponentType<Record<string, unknown>>,
              { key: e.message.id, role: e.message.role },
              React.createElement(
                "text" as unknown as React.ComponentType<Record<string, unknown>>,
                {},
                `RP:${joinText(e.message.content)}`,
              ),
            ),
          );
        },
      }),
      bridges,
    });
    const { tree } = await harness.renderTree({ mountId: "m_rp", sessionId: "s" });

    expect(observed).not.toBeNull();
    expect(observed!.count).toBe(2);
    expect(observed!.budget).toBeNull();

    const messages = asMessageEntries(tree.context.entries);
    expect(messages.map((m) => joinText(m.content))).toEqual(["RP:hello", "RP:world"]);
  });
});

describe("<Timeline> — token budget", () => {
  it("evicts oldest entries when over budget and fires onEvict", async () => {
    // Each entry text length ≈ 100 chars → ~29 tokens with overhead.
    const text = "x".repeat(100);
    const entries: MessageTimelineEntry[] = [];
    for (let i = 0; i < 6; i++) entries.push(userEntry(`e${i}`, text));
    const timeline = mockTimelineHarness(entries);
    const bridges: HookBridges = { ...stubBridges(), timeline };
    const harness = await makeHarness();

    const onEvict = vi.fn();

    // Budget for ~2 entries.
    const perEntry = getEntryTokens(entries[0]!);
    const budget = perEntry * 2;

    await harness.mount({
      mountId: "m_bud",
      sessionId: "s",
      element: React.createElement(Timeline, {
        maxTokens: budget,
        strategy: "truncate",
        onEvict,
      }),
      bridges,
    });
    const { tree } = await harness.renderTree({ mountId: "m_bud", sessionId: "s" });

    const messages = asMessageEntries(tree.context.entries);
    expect(messages).toHaveLength(2);
    // Newest preserved.
    expect(messages.map((m) => m.id)).toEqual(["e4", "e5"]);

    // onEvict fires post-render with the dropped entries.
    expect(onEvict).toHaveBeenCalledTimes(1);
    const dropped = onEvict.mock.calls[0]![0] as readonly MessageTimelineEntry[];
    expect(dropped.map((e) => e.message.id)).toEqual(["e0", "e1", "e2", "e3"]);
  });

  it("preserves `system` role under sliding-window even when budget is tight", async () => {
    const text = "x".repeat(100);
    const entries: MessageTimelineEntry[] = [
      systemEntry("sys", text),
      userEntry("u1", text),
      userEntry("u2", text),
      userEntry("u3", text),
    ];
    const timeline = mockTimelineHarness(entries);
    const bridges: HookBridges = { ...stubBridges(), timeline };
    const harness = await makeHarness();

    const perEntry = getEntryTokens(entries[0]!);
    // Only enough for sys + one user.
    const budget = perEntry * 2;

    await harness.mount({
      mountId: "m_sw",
      sessionId: "s",
      element: React.createElement(Timeline, {
        maxTokens: budget,
        strategy: "sliding-window",
      }),
      bridges,
    });
    const { tree } = await harness.renderTree({ mountId: "m_sw", sessionId: "s" });

    const messages = asMessageEntries(tree.context.entries);
    expect(messages.map((m) => m.id)).toContain("sys");
    expect(messages.map((m) => m.id)).toContain("u3");
    expect(messages).toHaveLength(2);
  });
});

// ============================================================================
// Pure compaction unit tests (no harness needed)
// ============================================================================

describe("compactEntries", () => {
  it("returns all entries unchanged when total tokens <= budget", () => {
    const entries = [userEntry("a", "hi"), userEntry("b", "ho")];
    const result = compactEntries(entries, { maxTokens: 10_000 });
    expect(result.kept).toEqual(entries);
    expect(result.evicted).toEqual([]);
  });

  it("returns all entries unchanged when strategy is `none`", () => {
    const entries = [userEntry("a", "x".repeat(10_000))];
    const result = compactEntries(entries, { maxTokens: 5, strategy: "none" });
    expect(result.kept).toEqual(entries);
    expect(result.evicted).toEqual([]);
  });

  it("invokes custom compaction function with current totals", () => {
    const entries = [userEntry("a", "long"), userEntry("b", "longer")];
    const fn = vi.fn().mockReturnValue({ kept: [entries[1]!], evicted: [entries[0]!] });
    const result = compactEntries(entries, {
      maxTokens: 1, // force overflow path
      strategy: fn,
      guidance: "drop oldest",
    });
    expect(fn).toHaveBeenCalledTimes(1);
    const [passedEntries, budget, guidance] = fn.mock.calls[0]!;
    expect(passedEntries).toEqual(entries);
    expect(budget).toMatchObject({ maxTokens: 1 });
    expect(guidance).toBe("drop oldest");
    expect(result.kept).toEqual([entries[1]!]);
    expect(result.evicted).toEqual([entries[0]!]);
  });
});
