/**
 * `<Timeline>` — read persisted entries through the TimelineHarness and
 * re-emit them through the collect pipeline.
 */

import React from "react";
import { describe, expect, it, vi } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { extractText } from "@agentick/spec-next";
import type { HookBridges, MessageEntry, TimelineEntry } from "@agentick/spec-next";

import { Message, ReconcilerHarness } from "@agentick/reconciler-react-next";
import { fakeBridges, fakeTimelineHarness } from "@agentick/reconciler-next";
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
    const timeline = fakeTimelineHarness([userEntry("e1", "hello"), assistantEntry("e2", "world")]);
    const bridges: HookBridges = { ...fakeBridges(), timeline };
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
    const timeline = fakeTimelineHarness();
    const bridges: HookBridges = { ...fakeBridges(), timeline };
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
    const timeline = fakeTimelineHarness([
      systemEntry("s1", "you are helpful"),
      userEntry("u1", "hi"),
      assistantEntry("a1", "yo"),
    ]);
    const bridges: HookBridges = { ...fakeBridges(), timeline };
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
    const timeline = fakeTimelineHarness(entries);
    const bridges: HookBridges = { ...fakeBridges(), timeline };
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
    const timeline = fakeTimelineHarness([
      userEntry("u1", "yes"),
      userEntry("u2", "no"),
      userEntry("u3", "yes"),
    ]);
    const bridges: HookBridges = { ...fakeBridges(), timeline };
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
    const timeline = fakeTimelineHarness([userEntry("u1", "hello"), assistantEntry("a1", "world")]);
    const bridges: HookBridges = { ...fakeBridges(), timeline };
    const harness = await makeHarness();

    let observed: { count: number; budget: TokenBudgetInfo | null } | null = null;

    await harness.mount({
      mountId: "m_rp",
      sessionId: "s",
      element: (
        <Timeline>
          {(entries, budget) => {
            observed = { count: entries.length, budget };
            // `<text>` is omitted from the v2 JSX augmentation because
            // it collides with SVG's <text>. Adopters use `<Text>` (the
            // uppercase wrapper); this test uses createElement directly.
            return entries.map((e) =>
              React.createElement(
                "message",
                { key: e.message.id, role: e.message.role },
                React.createElement(
                  "text" as unknown as React.ComponentType<Record<string, unknown>>,
                  {},
                  `RP:${joinText(e.message.content)}`,
                ),
              ),
            );
          }}
        </Timeline>
      ),
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
    const timeline = fakeTimelineHarness(entries);
    const bridges: HookBridges = { ...fakeBridges(), timeline };
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
    const timeline = fakeTimelineHarness(entries);
    const bridges: HookBridges = { ...fakeBridges(), timeline };
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

describe("<Timeline> — fine-grained rendering (README reference pattern)", () => {
  // Old tool-result entry whose heavy payload the tool layer extracted
  // to disk, stamping a file reference on the block metadata.
  function toolResultEntry(
    id: string,
    execId: string,
    ref: { path: string; bytes: number },
  ): MessageTimelineEntry {
    return {
      kind: "message",
      message: {
        id,
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolUseId: "tc1",
            name: "query_jobs",
            content: [{ type: "text", text: "HUGE 48KB payload ..." }],
            metadata: { file: ref },
          } as never,
        ],
        ts: 0,
        metadata: { executionId: execId },
      },
    };
  }

  function currentUser(id: string, text: string, execId: string): MessageTimelineEntry {
    return {
      kind: "message",
      message: {
        id,
        role: "user",
        content: [{ type: "text", text }],
        ts: 0,
        metadata: { executionId: execId },
      },
    };
  }

  it("collapses OLD tool results to a chaseable file reference; keeps CURRENT-turn verbatim", async () => {
    const CUR = "exec:current";
    const timeline = fakeTimelineHarness([
      toolResultEntry("t_old", "exec:old", { path: "/tmp/r/abc.json", bytes: 48_000 }),
      currentUser("u_cur", "and now summarize", CUR),
    ]);
    const bridges: HookBridges = { ...fakeBridges(), timeline };
    const harness = await makeHarness();

    // The README pattern, real exports: build a content array per
    // entry and pass it via the `content` prop (v2 has no <Text>
    // component — content blocks are the currency).
    function ReferenceTimeline() {
      const currentExecution = CUR; // in real use: useOnExecutionStart
      return React.createElement(Timeline, {
        children: (entries: readonly MessageTimelineEntry[]) =>
          entries.map(({ message }) => {
            if (
              message.role === "assistant" ||
              message.metadata?.executionId === currentExecution
            ) {
              return React.createElement(Message, { key: message.id, ...message });
            }
            const content = message.content.map((block) => {
              if (block.type === "tool_result") {
                const ref = (block as { metadata?: { file?: { path: string; bytes: number } } })
                  .metadata?.file;
                return {
                  type: "text" as const,
                  text: ref
                    ? `[${block.name}] full result at ${ref.path} (${ref.bytes}B) — read_file if needed`
                    : `[${block.name}]`,
                };
              }
              return block;
            });
            return React.createElement(Message, { key: message.id, role: message.role, content });
          }),
      });
    }

    await harness.mount({
      mountId: "m_ref",
      sessionId: "s",
      element: React.createElement(ReferenceTimeline),
      bridges,
    });
    const { tree } = await harness.renderTree({ mountId: "m_ref", sessionId: "s" });
    const messages = asMessageEntries(tree.context.entries);

    // Old tool result → a reference the model can chase, NOT the payload.
    const toolMsg = messages.find((m) => m.role === "tool")!;
    const toolText = joinText(toolMsg.content);
    expect(toolText).toContain("/tmp/r/abc.json");
    expect(toolText).toContain("read_file if needed");
    expect(toolText).not.toContain("HUGE 48KB payload");

    // Current-turn user message → verbatim.
    const userMsg = messages.find((m) => m.role === "user")!;
    expect(joinText(userMsg.content)).toBe("and now summarize");
  });
});

describe("<Transcript> — conversational alias (#205)", () => {
  it("is the same component as Timeline and renders identically", async () => {
    const { Transcript } = await import("@agentick/timeline-next/react");
    expect(Transcript).toBe(Timeline);

    const seed = [userEntry("e1", "hello"), assistantEntry("e2", "world")];
    const bridges: HookBridges = { ...fakeBridges(), timeline: fakeTimelineHarness(seed) };
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m_tr",
      sessionId: "s",
      element: React.createElement(Transcript),
      bridges,
    });
    const { tree } = await harness.renderTree({ mountId: "m_tr", sessionId: "s" });
    const messages = asMessageEntries(tree.context.entries);
    expect(messages.map((m) => joinText(m.content))).toEqual(["hello", "world"]);
  });
});
