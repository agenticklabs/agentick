import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@agentick/client";
import type { ContentBlock } from "@agentick/shared";
import { buildContentFilter, applyContentPolicy } from "../content-pipeline.js";

function textBlock(text: string): ContentBlock {
  return { type: "text", text } as ContentBlock;
}

function toolUseBlock(name: string, input: Record<string, unknown> = {}): ContentBlock {
  return { type: "tool_use", toolUseId: `tu_${name}`, name, input } as ContentBlock;
}

function toolResultBlock(toolUseId: string, text: string): ContentBlock {
  return { type: "tool_result", toolUseId, content: [{ type: "text", text }] } as ContentBlock;
}

function assistantMsg(content: ContentBlock[], id = "msg_1"): ChatMessage {
  return { id, role: "assistant", content };
}

function userMsg(text: string, id = "msg_u"): ChatMessage {
  return { id, role: "user", content: text };
}

describe("buildContentFilter", () => {
  describe("full", () => {
    it("passes messages through unchanged", () => {
      const filter = buildContentFilter("full");
      const msg = assistantMsg([textBlock("hello"), toolUseBlock("shell")]);
      expect(filter(msg)).toBe(msg);
    });
  });

  describe("text-only", () => {
    it("strips tool_use blocks", () => {
      const filter = buildContentFilter("text-only");
      const msg = assistantMsg([textBlock("hello"), toolUseBlock("shell")]);
      const result = filter(msg)!;
      expect(result.content).toHaveLength(1);
      expect((result.content as ContentBlock[])[0]).toEqual(textBlock("hello"));
      expect(result.toolCalls).toBeUndefined();
    });

    it("returns null for tool-only messages", () => {
      const filter = buildContentFilter("text-only");
      const msg = assistantMsg([toolUseBlock("shell")]);
      expect(filter(msg)).toBeNull();
    });

    it("passes string content through", () => {
      const filter = buildContentFilter("text-only");
      const msg: ChatMessage = { id: "m", role: "assistant", content: "hello" };
      expect(filter(msg)).toBe(msg);
    });
  });

  describe("summarized", () => {
    it("replaces tool_use with summaries", () => {
      const filter = buildContentFilter("summarized");
      const msg = assistantMsg([
        textBlock("Looking into that..."),
        toolUseBlock("Glob", { pattern: "**/*.ts" }),
      ]);
      const result = filter(msg)!;
      const blocks = result.content as ContentBlock[];
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toEqual(textBlock("Looking into that..."));
      expect((blocks[1] as { type: string; text: string }).text).toContain("Searched for files");
      expect(result.toolCalls).toBeUndefined();
    });

    it("drops tool_result blocks", () => {
      const filter = buildContentFilter("summarized");
      const msg = assistantMsg([toolUseBlock("shell"), toolResultBlock("tu_shell", "output")]);
      const result = filter(msg)!;
      const blocks = result.content as ContentBlock[];
      expect(blocks).toHaveLength(1);
      expect((blocks[0] as { type: string; text: string }).text).toContain("Ran a command");
    });

    it("summarizes well-known tools", () => {
      const filter = buildContentFilter("summarized");

      const cases: Array<[string, Record<string, unknown>, string]> = [
        ["ReadFile", { path: "foo.ts" }, "Read foo.ts"],
        ["WriteFile", { path: "bar.ts" }, "Wrote bar.ts"],
        ["EditFile", { path: "baz.ts" }, "Edited baz.ts"],
        ["Shell", { command: "ls -la" }, "Ran: ls -la"],
        ["Grep", { pattern: "TODO" }, 'Searched for "TODO"'],
        ["unknown_tool", {}, "Used unknown_tool"],
      ];

      for (const [name, input, expected] of cases) {
        const msg = assistantMsg([toolUseBlock(name, input)]);
        const result = filter(msg)!;
        const text = ((result.content as ContentBlock[])[0] as { text: string }).text;
        expect(text).toContain(expected);
      }
    });
  });

  describe("custom function", () => {
    it("uses the provided function", () => {
      const filter = buildContentFilter((msg) => ({
        ...msg,
        content: "custom",
      }));
      const msg = assistantMsg([textBlock("hello")]);
      expect(filter(msg)!.content).toBe("custom");
    });
  });
});

describe("applyContentPolicy", () => {
  it("passes user messages through unchanged", () => {
    const filter = buildContentFilter("text-only");
    const messages = [userMsg("hi"), assistantMsg([toolUseBlock("shell")])];
    const result = applyContentPolicy(messages, filter);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("filters out null results from assistant messages", () => {
    const filter = buildContentFilter("text-only");
    const messages = [assistantMsg([toolUseBlock("shell")])];
    const result = applyContentPolicy(messages, filter);
    expect(result).toHaveLength(0);
  });
});
