import { describe, it, expect } from "vitest";
import type { ContentBlock, Message } from "@agentick/shared";
import { extractToolCalls, timelineToMessages } from "../chat-transforms.js";
import type { TimelineEntry } from "../chat-types.js";

function makeTimelineEntry(overrides: {
  role: "user" | "assistant" | "tool" | "event";
  content: ContentBlock[];
  id?: string;
}): TimelineEntry {
  return {
    kind: "message",
    message: {
      id: overrides.id ?? `msg-${Math.random().toString(36).slice(2, 8)}`,
      role: overrides.role,
      content: overrides.content,
    },
  };
}

function textBlock(text: string): ContentBlock {
  return { type: "text", text } as ContentBlock;
}

function toolUseBlock(id: string, name: string, input: Record<string, unknown> = {}): ContentBlock {
  return { type: "tool_use", id, name, input } as ContentBlock;
}

function toolResultBlock(toolUseId: string, content: string): ContentBlock {
  return {
    type: "tool_result",
    toolUseId,
    name: "test_tool",
    content: [{ type: "text", text: content }],
    isError: false,
  } as unknown as ContentBlock;
}

describe("extractToolCalls", () => {
  it("extracts tool_use blocks from content", () => {
    const blocks = [textBlock("Let me search"), toolUseBlock("tc-1", "search", { q: "test" })];
    expect(extractToolCalls(blocks)).toEqual([{ id: "tc-1", name: "search", status: "done" }]);
  });

  it("extracts multiple tool calls", () => {
    const blocks = [
      toolUseBlock("tc-1", "read_file", { path: "/a.ts" }),
      toolUseBlock("tc-2", "write_file", { path: "/b.ts", content: "x" }),
    ];
    expect(extractToolCalls(blocks)).toEqual([
      { id: "tc-1", name: "read_file", status: "done" },
      { id: "tc-2", name: "write_file", status: "done" },
    ]);
  });

  it("returns empty array when no tool_use blocks", () => {
    expect(extractToolCalls([textBlock("no tools")])).toEqual([]);
  });

  it("ignores tool_result blocks", () => {
    const blocks = [toolResultBlock("tc-1", "file contents"), textBlock("Here's the file")];
    expect(extractToolCalls(blocks)).toEqual([]);
  });
});

describe("timelineToMessages", () => {
  const emptyDurations = new Map<string, number>();

  it("converts a simple user + assistant exchange", () => {
    const entries = [
      makeTimelineEntry({ role: "user", content: [textBlock("Hello")], id: "u1" }),
      makeTimelineEntry({ role: "assistant", content: [textBlock("Hi there!")], id: "a1" }),
    ];

    const result = timelineToMessages(entries, emptyDurations);

    expect(result).toEqual([
      { id: "u1", role: "user", content: [textBlock("Hello")], toolCalls: undefined },
      { id: "a1", role: "assistant", content: [textBlock("Hi there!")], toolCalls: undefined },
    ]);
  });

  it("filters out tool messages", () => {
    const entries = [
      makeTimelineEntry({ role: "user", content: [textBlock("Search for foo")] }),
      makeTimelineEntry({
        role: "assistant",
        content: [textBlock("Searching..."), toolUseBlock("tc-1", "search")],
      }),
      makeTimelineEntry({ role: "tool", content: [toolResultBlock("tc-1", "found: bar")] }),
      makeTimelineEntry({ role: "assistant", content: [textBlock("Found bar!")] }),
    ];

    const result = timelineToMessages(entries, emptyDurations);

    expect(result).toHaveLength(3);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
    expect(result[1].toolCalls).toEqual([{ id: "tc-1", name: "search", status: "done" }]);
    expect(result[2].content).toEqual([textBlock("Found bar!")]);
  });

  it("filters out event messages", () => {
    const entries = [
      makeTimelineEntry({ role: "event", content: [textBlock("system event")] }),
      makeTimelineEntry({ role: "user", content: [textBlock("Hello")] }),
    ];

    const result = timelineToMessages(entries, emptyDurations);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("attaches tool durations when available", () => {
    const durations = new Map([["tc-1", 1500]]);
    const entries = [
      makeTimelineEntry({
        role: "assistant",
        content: [textBlock("Let me check"), toolUseBlock("tc-1", "glob")],
        id: "a1",
      }),
    ];

    const result = timelineToMessages(entries, durations);

    expect(result[0].toolCalls).toEqual([
      { id: "tc-1", name: "glob", status: "done", duration: 1500 },
    ]);
  });

  it("handles entries without kind field", () => {
    const entries: TimelineEntry[] = [
      { message: { role: "user", content: [textBlock("hello")] } as Message },
    ];

    expect(timelineToMessages(entries, emptyDurations)).toHaveLength(0);
  });

  it("handles entries without message field", () => {
    const entries: TimelineEntry[] = [{ kind: "message" }];

    expect(timelineToMessages(entries, emptyDurations)).toHaveLength(0);
  });

  it("generates synthetic IDs when message.id is missing", () => {
    const entries = [makeTimelineEntry({ role: "user", content: [textBlock("test")] })];
    (entries[0].message as any).id = undefined;

    const result = timelineToMessages(entries, emptyDurations);
    expect(result[0].id).toBe("msg-0");
  });

  it("returns empty array for empty input", () => {
    expect(timelineToMessages([], emptyDurations)).toEqual([]);
  });
});
