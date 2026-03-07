import { StreamTagParser } from "../stream-tag-parser.js";
import type { AdapterDelta } from "../stream-accumulator.js";
import { vi } from "vitest";

function text(delta: string): AdapterDelta {
  return { type: "text", delta };
}

/** Feed chunks through parser, collecting all output deltas. */
function collectAll(parser: StreamTagParser, chunks: string[]): AdapterDelta[] {
  const results: AdapterDelta[] = [];
  for (const chunk of chunks) {
    results.push(...parser.process(text(chunk)));
  }
  results.push(...parser.flush());
  return results;
}

/** Filter to just text deltas, joined. */
function textOutput(deltas: AdapterDelta[]): string {
  return deltas
    .filter((d) => d.type === "text")
    .map((d) => (d as { delta: string }).delta)
    .join("");
}

/** Filter to just custom_block events (complete blocks). */
function customBlocks(
  deltas: AdapterDelta[],
): Array<{ tag: string; content: string; attrs: Record<string, string> }> {
  return deltas
    .filter((d) => d.type === "custom_block")
    .map((d) => {
      const b = d as { tag: string; content: string; attrs: Record<string, string> };
      return { tag: b.tag, content: b.content, attrs: b.attrs };
    });
}

function createParser(
  tags?: Record<
    string,
    {
      onStart?: (attrs: Record<string, string>) => void;
      onContent?: (content: string, attrs: Record<string, string>) => void;
      onSelfClosing?: (attrs: Record<string, string>) => void;
    }
  >,
) {
  return new StreamTagParser({
    tags: tags ?? {
      think: {},
      interpretation: {},
      done: {},
      "debug-info": {},
    },
  });
}

describe("StreamTagParser", () => {
  describe("passthrough (no registered tags)", () => {
    it("passes text through when no tags present", () => {
      const parser = createParser();
      const results = collectAll(parser, ["Hello, world!"]);
      expect(textOutput(results)).toBe("Hello, world!");
    });

    it("passes multiple chunks through", () => {
      const parser = createParser();
      const results = collectAll(parser, ["Hello", ", ", "world!"]);
      expect(textOutput(results)).toBe("Hello, world!");
    });

    it("passes non-text deltas through unchanged", () => {
      const parser = createParser();
      const toolDelta: AdapterDelta = { type: "tool_call_start", id: "1", name: "test" };
      const results = parser.process(toolDelta);
      expect(results).toEqual([toolDelta]);
    });

    it("passes unregistered tags through as text", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<b>bold</b> and <i>italic</i>"]);
      expect(textOutput(results)).toBe("<b>bold</b> and <i>italic</i>");
    });

    it("handles angle brackets in regular text", () => {
      const parser = createParser();
      const results = collectAll(parser, ["x < y and y > z"]);
      expect(textOutput(results)).toBe("x < y and y > z");
    });
  });

  describe("complete tag in single chunk", () => {
    it("extracts a simple registered tag", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<think>reasoning here</think>answer"]);
      expect(textOutput(results)).toBe("answer");
      const blocks = customBlocks(results);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toEqual({ tag: "think", content: "reasoning here", attrs: {} });
    });

    it("extracts tag with text before and after", () => {
      const parser = createParser();
      const results = collectAll(parser, ["prefix <think>middle</think> suffix"]);
      expect(textOutput(results)).toBe("prefix  suffix");
      expect(customBlocks(results)[0].content).toBe("middle");
    });

    it("extracts tag with attributes", () => {
      const parser = createParser();
      const results = collectAll(parser, [
        '<interpretation for="block-123">summary here</interpretation>',
      ]);
      const blocks = customBlocks(results);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].tag).toBe("interpretation");
      expect(blocks[0].content).toBe("summary here");
      expect(blocks[0].attrs).toEqual({ for: "block-123" });
    });

    it("handles self-closing tag", () => {
      const parser = createParser();
      const results = collectAll(parser, ["All done.<done/>More text."]);
      expect(textOutput(results)).toBe("All done.More text.");
      const blocks = customBlocks(results);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].tag).toBe("done");
      expect(blocks[0].content).toBe("");
    });

    it("handles hyphenated tag names", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<debug-info>diagnostic data</debug-info>rest"]);
      expect(textOutput(results)).toBe("rest");
      expect(customBlocks(results)[0]).toEqual({
        tag: "debug-info",
        content: "diagnostic data",
        attrs: {},
      });
    });
  });

  describe("tags split across chunks", () => {
    it("handles opening tag split: '<thi' + 'nk>content</think>'", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<thi", "nk>content</think>"]);
      expect(textOutput(results)).toBe("");
      expect(customBlocks(results)[0].content).toBe("content");
    });

    it("handles opening tag split: '<' + 'think>content</think>'", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<", "think>content</think>"]);
      expect(customBlocks(results)[0].content).toBe("content");
    });

    it("handles closing tag split: '<think>content</thi' + 'nk>rest'", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<think>content</thi", "nk>rest"]);
      expect(textOutput(results)).toBe("rest");
      expect(customBlocks(results)[0].content).toBe("content");
    });

    it("handles closing tag split: '<think>content</' + 'think>rest'", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<think>content</", "think>rest"]);
      expect(textOutput(results)).toBe("rest");
      expect(customBlocks(results)[0].content).toBe("content");
    });

    it("handles tag split one char at a time", () => {
      const parser = createParser();
      const input = "<think>hello</think>world";
      const results = collectAll(parser, input.split(""));
      expect(textOutput(results)).toBe("world");
      expect(customBlocks(results)[0].content).toBe("hello");
    });

    it("handles self-closing tag split: '<done' + '/>rest'", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<done", "/>rest"]);
      expect(textOutput(results)).toBe("rest");
      expect(customBlocks(results)).toHaveLength(1);
    });

    it("handles self-closing tag split at slash: '<done/' + '>rest'", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<done/", ">rest"]);
      expect(textOutput(results)).toBe("rest");
      expect(customBlocks(results)).toHaveLength(1);
    });

    it("handles attributes split across chunks", () => {
      const parser = createParser();
      const results = collectAll(parser, [
        '<interpretation for="blo',
        'ck-123">content</interpretation>',
      ]);
      const blocks = customBlocks(results);
      expect(blocks[0].attrs).toEqual({ for: "block-123" });
      expect(blocks[0].content).toBe("content");
    });

    it("handles content split across many chunks", () => {
      const parser = createParser();
      const results = collectAll(parser, [
        "<think>",
        "chunk1 ",
        "chunk2 ",
        "chunk3",
        "</think>",
        "after",
      ]);
      expect(textOutput(results)).toBe("after");
      expect(customBlocks(results)[0].content).toBe("chunk1 chunk2 chunk3");
    });
  });

  describe("multiple tags", () => {
    it("handles two consecutive tags", () => {
      const parser = createParser();
      const results = collectAll(parser, [
        "<think>first</think>between<interpretation>second</interpretation>end",
      ]);
      expect(textOutput(results)).toBe("betweenend");
      const blocks = customBlocks(results);
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toEqual({ tag: "think", content: "first", attrs: {} });
      expect(blocks[1]).toEqual({ tag: "interpretation", content: "second", attrs: {} });
    });

    it("handles tags across chunks", () => {
      const parser = createParser();
      const results = collectAll(parser, [
        "<think>first</think>",
        "gap",
        "<think>second</think>",
        "tail",
      ]);
      expect(textOutput(results)).toBe("gaptail");
      const blocks = customBlocks(results);
      expect(blocks).toHaveLength(2);
    });

    it("handles mixed self-closing and regular tags", () => {
      const parser = createParser();
      const results = collectAll(parser, ["text<done/><think>reasoning</think>more"]);
      expect(textOutput(results)).toBe("textmore");
      const blocks = customBlocks(results);
      expect(blocks).toHaveLength(2);
      expect(blocks[0].tag).toBe("done");
      expect(blocks[1].tag).toBe("think");
    });
  });

  describe("attributes", () => {
    it("parses single-quoted attributes", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<interpretation for='block-1'>x</interpretation>"]);
      expect(customBlocks(results)[0].attrs).toEqual({ for: "block-1" });
    });

    it("parses multiple attributes", () => {
      const parser = createParser();
      const results = collectAll(parser, [
        '<interpretation for="block-1" confidence="high">x</interpretation>',
      ]);
      expect(customBlocks(results)[0].attrs).toEqual({ for: "block-1", confidence: "high" });
    });

    it("parses unquoted attribute values", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<interpretation for=block-1>x</interpretation>"]);
      expect(customBlocks(results)[0].attrs).toEqual({ for: "block-1" });
    });

    it("parses self-closing tag with attributes", () => {
      const parser = createParser();
      const results = collectAll(parser, ['<done reason="complete"/>']);
      const blocks = customBlocks(results);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].attrs).toEqual({ reason: "complete" });
    });
  });

  describe("stream events (custom_block_start, delta, end)", () => {
    it("emits lifecycle events for a complete tag", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<think>content</think>"]);

      const types = results.map((d) => d.type);
      expect(types).toContain("custom_block_start");
      expect(types).toContain("custom_block_delta");
      expect(types).toContain("custom_block_end");
      expect(types).toContain("custom_block");
    });

    it("emits deltas as content streams in (coalesced per process call)", () => {
      const parser = createParser();
      const results: AdapterDelta[] = [];
      results.push(...parser.process(text("<think>")));
      results.push(...parser.process(text("chunk1 ")));
      results.push(...parser.process(text("chunk2")));
      results.push(...parser.process(text("</think>")));
      results.push(...parser.flush());

      // Content deltas are coalesced per process() call — one delta per chunk
      const deltas = results
        .filter((d) => d.type === "custom_block_delta")
        .map((d) => (d as { delta: string }).delta);
      expect(deltas).toEqual(["chunk1 ", "chunk2"]);
    });

    it("emits start with attrs", () => {
      const parser = createParser();
      const results = collectAll(parser, ['<interpretation for="x">y</interpretation>']);
      const start = results.find((d) => d.type === "custom_block_start") as any;
      expect(start.tag).toBe("interpretation");
      expect(start.attrs).toEqual({ for: "x" });
    });
  });

  describe("handler callbacks", () => {
    it("calls onContent when tag closes", () => {
      const onContent = vi.fn();
      const parser = new StreamTagParser({
        tags: { think: { onContent } },
      });
      collectAll(parser, ["<think>reasoning</think>"]);
      expect(onContent).toHaveBeenCalledWith("reasoning", {});
    });

    it("calls onContent with attrs", () => {
      const onContent = vi.fn();
      const parser = new StreamTagParser({
        tags: { interpretation: { onContent } },
      });
      collectAll(parser, ['<interpretation for="b1">summary</interpretation>']);
      expect(onContent).toHaveBeenCalledWith("summary", { for: "b1" });
    });

    it("calls onSelfClosing for self-closing tags", () => {
      const onSelfClosing = vi.fn();
      const parser = new StreamTagParser({
        tags: { done: { onSelfClosing } },
      });
      collectAll(parser, ["<done/>"]);
      expect(onSelfClosing).toHaveBeenCalledWith({});
    });

    it("calls onSelfClosing with attrs", () => {
      const onSelfClosing = vi.fn();
      const parser = new StreamTagParser({
        tags: { done: { onSelfClosing } },
      });
      collectAll(parser, ['<done reason="complete"/>']);
      expect(onSelfClosing).toHaveBeenCalledWith({ reason: "complete" });
    });

    it("calls onStart when opening tag is found (no attrs)", () => {
      const onStart = vi.fn();
      const parser = new StreamTagParser({
        tags: { think: { onStart } },
      });
      collectAll(parser, ["<think>content</think>"]);
      expect(onStart).toHaveBeenCalledOnce();
      expect(onStart).toHaveBeenCalledWith({});
    });

    it("calls onStart with attrs", () => {
      const onStart = vi.fn();
      const parser = new StreamTagParser({
        tags: { interpretation: { onStart } },
      });
      collectAll(parser, ['<interpretation for="b1" confidence="high">content</interpretation>']);
      expect(onStart).toHaveBeenCalledOnce();
      expect(onStart).toHaveBeenCalledWith({ for: "b1", confidence: "high" });
    });

    it("calls onStart before onContent", () => {
      const order: string[] = [];
      const parser = new StreamTagParser({
        tags: {
          think: {
            onStart: () => order.push("start"),
            onContent: () => order.push("content"),
          },
        },
      });
      collectAll(parser, ["<think>x</think>"]);
      expect(order).toEqual(["start", "content"]);
    });

    it("does not call onStart for self-closing tags", () => {
      const onStart = vi.fn();
      const parser = new StreamTagParser({
        tags: { done: { onStart } },
      });
      collectAll(parser, ["<done/>"]);
      expect(onStart).not.toHaveBeenCalled();
    });

    it("calls onStart for each occurrence when tag appears multiple times", () => {
      const onStart = vi.fn();
      const parser = new StreamTagParser({
        tags: { think: { onStart } },
      });
      collectAll(parser, ["<think>a</think>text<think>b</think>"]);
      expect(onStart).toHaveBeenCalledTimes(2);
    });
  });

  describe("adversarial: edge cases", () => {
    it("handles empty tag content", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<think></think>after"]);
      expect(textOutput(results)).toBe("after");
      expect(customBlocks(results)[0].content).toBe("");
    });

    it("handles close tag without matching open (outside content)", () => {
      const parser = createParser();
      const results = collectAll(parser, ["no open </think> here"]);
      expect(textOutput(results)).toBe("no open </think> here");
    });

    it("handles nested same-name tags (no nesting support)", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<think>outer<think>inner</think>after"]);
      // Inner <think> is just content text — first </think> closes
      expect(customBlocks(results)[0].content).toBe("outer<think>inner");
      expect(textOutput(results)).toBe("after");
    });

    it("handles non-matching close tag inside content", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<think>has </b> inside</think>rest"]);
      expect(customBlocks(results)[0].content).toBe("has </b> inside");
      expect(textOutput(results)).toBe("rest");
    });

    it("handles < inside content that isn't a close tag", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<think>x < y</think>rest"]);
      expect(customBlocks(results)[0].content).toBe("x < y");
    });

    it("handles unclosed tag at stream end", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<think>never closes"]);
      // Best effort: emit as custom block
      const blocks = customBlocks(results);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].content).toBe("never closes");
    });

    it("handles partial opening tag at stream end", () => {
      const parser = createParser();
      const results = collectAll(parser, ["text<thi"]);
      // Partial tag can't match — flush as text
      expect(textOutput(results)).toBe("text<thi");
    });

    it("handles empty input", () => {
      const parser = createParser();
      const results = parser.process(text(""));
      expect(results).toEqual([]);
    });

    it("handles tag with only whitespace content", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<think>   </think>after"]);
      expect(customBlocks(results)[0].content).toBe("   ");
    });

    it("does not parse think tags in tool_call_delta", () => {
      const parser = createParser();
      const toolDelta: AdapterDelta = {
        type: "tool_call_delta",
        id: "call_1",
        delta: '{"content":"<think>reasoning</think>"}',
      };
      const results = parser.process(toolDelta);
      expect(results).toEqual([toolDelta]);
    });

    it("handles consecutive close tags", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<think>x</think></think>tail"]);
      expect(customBlocks(results)[0].content).toBe("x");
      expect(textOutput(results)).toBe("</think>tail");
    });

    it("handles registered tag name as prefix of unregistered tag", () => {
      const parser = new StreamTagParser({ tags: { do: {} } });
      const results = collectAll(parser, ["<done/>rest"]);
      // "done" is not registered, only "do" is — but "done" != "do"
      expect(textOutput(results)).toBe("<done/>rest");
    });

    it("handles unregistered tag that shares prefix with registered", () => {
      const parser = createParser(); // has "think" registered
      const results = collectAll(parser, ["<thinking>hmm</thinking>rest"]);
      // "thinking" is not registered — passes through as text
      expect(textOutput(results)).toBe("<thinking>hmm</thinking>rest");
    });
  });

  describe("adversarial: chunk boundary stress", () => {
    it("handles close tag '</think>' split at every position", () => {
      const _parser = createParser();
      const closeTag = "</think>";

      for (let splitPos = 1; splitPos < closeTag.length; splitPos++) {
        const p = createParser();
        const before = closeTag.slice(0, splitPos);
        const after = closeTag.slice(splitPos);
        const results = collectAll(p, ["<think>content" + before, after + "rest"]);
        expect(customBlocks(results)[0]?.content).toBe("content");
        expect(textOutput(results)).toBe("rest");
      }
    });

    it("handles open tag '<think>' split at every position", () => {
      for (let splitPos = 1; splitPos < "<think>".length; splitPos++) {
        const p = createParser();
        const openTag = "<think>";
        const before = openTag.slice(0, splitPos);
        const after = openTag.slice(splitPos);
        const results = collectAll(p, [before, after + "content</think>rest"]);
        expect(customBlocks(results)[0]?.content).toBe("content");
        expect(textOutput(results)).toBe("rest");
      }
    });

    it("handles content '<' at chunk boundary", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<think>x<", "/think>rest"]);
      expect(customBlocks(results)[0].content).toBe("x");
      expect(textOutput(results)).toBe("rest");
    });

    it("handles content '</' at chunk boundary", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<think>x</", "think>rest"]);
      expect(customBlocks(results)[0].content).toBe("x");
      expect(textOutput(results)).toBe("rest");
    });

    it("handles false close tag start inside content", () => {
      const parser = createParser();
      // '</b>' inside content — not a match, should be content
      const results = collectAll(parser, ["<think>x</b>y</think>rest"]);
      expect(customBlocks(results)[0].content).toBe("x</b>y");
      expect(textOutput(results)).toBe("rest");
    });

    it("handles false close tag that shares prefix with active tag", () => {
      const parser = createParser();
      // '</thingy>' is not '</think>' — should be content
      const results = collectAll(parser, ["<think>x</thingy>y</think>rest"]);
      expect(customBlocks(results)[0].content).toBe("x</thingy>y");
      expect(textOutput(results)).toBe("rest");
    });
  });

  describe("adversarial: pathological inputs", () => {
    it("handles thousands of angle brackets without tags", () => {
      const parser = createParser();
      const input = "<".repeat(1000) + ">" + "<".repeat(500);
      const results = collectAll(parser, [input]);
      // None of these match registered tags — all pass through as text
      expect(textOutput(results)).toBe(input);
      expect(customBlocks(results)).toHaveLength(0);
    });

    it("handles very long tag content", () => {
      const parser = createParser();
      const longContent = "x".repeat(100_000);
      const results = collectAll(parser, [`<think>${longContent}</think>`]);
      expect(customBlocks(results)[0].content).toBe(longContent);
      expect(textOutput(results)).toBe("");
    });

    it("handles very long attribute value", () => {
      const parser = createParser();
      const longVal = "a".repeat(10_000);
      const results = collectAll(parser, [`<interpretation for="${longVal}">x</interpretation>`]);
      expect(customBlocks(results)[0].attrs.for).toBe(longVal);
    });

    it("handles rapid tag open/close alternation", () => {
      const parser = createParser();
      const chunks: string[] = [];
      for (let i = 0; i < 100; i++) {
        chunks.push(`<think>r${i}</think>t${i}`);
      }
      const results = collectAll(parser, chunks);
      expect(customBlocks(results)).toHaveLength(100);
      expect(customBlocks(results)[0].content).toBe("r0");
      expect(customBlocks(results)[99].content).toBe("r99");
    });

    it("handles many close tag false alarms inside content", () => {
      const parser = createParser();
      // Content with many </xxx> that don't match </think>
      const inner = Array.from({ length: 50 }, (_, i) => `</tag${i}>`).join("");
      const results = collectAll(parser, [`<think>${inner}</think>end`]);
      expect(customBlocks(results)[0].content).toBe(inner);
      expect(textOutput(results)).toBe("end");
    });

    it("handles tag name that is prefix of registered tag in content", () => {
      const parser = createParser();
      // </thi> inside content — shares prefix with </think> but doesn't match
      const results = collectAll(parser, ["<think>a</thi>b</think>c"]);
      expect(customBlocks(results)[0].content).toBe("a</thi>b");
      expect(textOutput(results)).toBe("c");
    });

    it("handles every byte boundary split for a complex input", () => {
      const input = '<interpretation for="b1">summary</interpretation>rest';
      for (let splitPos = 1; splitPos < input.length; splitPos++) {
        const p = createParser();
        const results = collectAll(p, [input.slice(0, splitPos), input.slice(splitPos)]);
        const blocks = customBlocks(results);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].tag).toBe("interpretation");
        expect(blocks[0].content).toBe("summary");
        expect(blocks[0].attrs).toEqual({ for: "b1" });
        expect(textOutput(results)).toBe("rest");
      }
    });

    it("handles every byte boundary for self-closing with attrs", () => {
      const input = '<done reason="complete"/>rest';
      for (let splitPos = 1; splitPos < input.length; splitPos++) {
        const p = createParser();
        const results = collectAll(p, [input.slice(0, splitPos), input.slice(splitPos)]);
        const blocks = customBlocks(results);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].tag).toBe("done");
        expect(blocks[0].attrs).toEqual({ reason: "complete" });
        expect(textOutput(results)).toBe("rest");
      }
    });

    it("handles interleaved registered and unregistered tags", () => {
      const parser = createParser();
      const results = collectAll(parser, [
        "<b>bold</b><think>reasoning</think><i>italic</i><done/>more",
      ]);
      expect(textOutput(results)).toBe("<b>bold</b><i>italic</i>more");
      const blocks = customBlocks(results);
      expect(blocks).toHaveLength(2);
      expect(blocks[0].tag).toBe("think");
      expect(blocks[1].tag).toBe("done");
    });

    it("handles empty string chunks interspersed", () => {
      const parser = createParser();
      const results = collectAll(parser, [
        "",
        "<think>",
        "",
        "content",
        "",
        "</think>",
        "",
        "end",
        "",
      ]);
      expect(customBlocks(results)[0].content).toBe("content");
      expect(textOutput(results)).toBe("end");
    });

    it("handles unicode content inside tags", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<think>こんにちは 🌍 émojis</think>after"]);
      expect(customBlocks(results)[0].content).toBe("こんにちは 🌍 émojis");
      expect(textOutput(results)).toBe("after");
    });

    it("handles newlines in content", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<think>\nline1\nline2\n</think>after"]);
      expect(customBlocks(results)[0].content).toBe("\nline1\nline2\n");
    });

    it("handles newlines in attributes", () => {
      const parser = createParser();
      const results = collectAll(parser, [
        '<interpretation\n  for="b1"\n  >content</interpretation>',
      ]);
      const blocks = customBlocks(results);
      expect(blocks[0].attrs).toEqual({ for: "b1" });
      expect(blocks[0].content).toBe("content");
    });
  });

  describe("adversarial: state coherence across many chunks", () => {
    it("handles 3-way split of opening tag with attrs", () => {
      const parser = createParser();
      const results = collectAll(parser, [
        "<inter",
        'pretation for="x"',
        ">content</interpretation>",
      ]);
      expect(customBlocks(results)[0].tag).toBe("interpretation");
      expect(customBlocks(results)[0].attrs).toEqual({ for: "x" });
    });

    it("handles 4-way split across tag boundary", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<thi", "nk>con", "tent</th", "ink>rest"]);
      expect(customBlocks(results)[0].content).toBe("content");
      expect(textOutput(results)).toBe("rest");
    });

    it("handles close tag name split at every char", () => {
      // Split '</think>' into '</t', 'h', 'i', 'n', 'k', '>'
      const parser = createParser();
      const results = collectAll(parser, ["<think>content</t", "h", "i", "n", "k", ">rest"]);
      expect(customBlocks(results)[0].content).toBe("content");
      expect(textOutput(results)).toBe("rest");
    });

    it("preserves handler call order with multiple tags", () => {
      const calls: string[] = [];
      const parser = new StreamTagParser({
        tags: {
          think: { onContent: (c) => calls.push(`think:${c}`) },
          done: { onSelfClosing: () => calls.push("done:self") },
          interpretation: { onContent: (c) => calls.push(`interp:${c}`) },
        },
      });
      collectAll(parser, [
        '<think>r1</think>text<done/><interpretation for="x">s1</interpretation>end',
      ]);
      expect(calls).toEqual(["think:r1", "done:self", "interp:s1"]);
    });

    it("handles multiple consecutive self-closing tags", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<done/><done/><done/>text"]);
      expect(customBlocks(results)).toHaveLength(3);
      expect(textOutput(results)).toBe("text");
    });

    it("handles tag immediately after tag with no gap", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<think>a</think><think>b</think>"]);
      const blocks = customBlocks(results);
      expect(blocks).toHaveLength(2);
      expect(blocks[0].content).toBe("a");
      expect(blocks[1].content).toBe("b");
    });

    it("handles registered tag name appearing as attribute value", () => {
      const parser = createParser();
      const results = collectAll(parser, ['<interpretation for="think">x</interpretation>']);
      expect(customBlocks(results)[0].attrs.for).toBe("think");
      expect(customBlocks(results)[0].content).toBe("x");
    });
  });

  describe("adversarial: malformed input resilience", () => {
    it("handles double angle brackets", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<<think>>content<</think>>"]);
      // First '<' is text, '<think>' matches, '>content<' is in content...
      // The exact behavior depends on state machine, but it shouldn't crash
      expect(results.length).toBeGreaterThan(0);
    });

    it("handles tag with equals in content", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<think>x = y + z</think>rest"]);
      expect(customBlocks(results)[0].content).toBe("x = y + z");
    });

    it("handles tag with quotes in content", () => {
      const parser = createParser();
      const results = collectAll(parser, ['<think>he said "hello"</think>rest']);
      expect(customBlocks(results)[0].content).toBe('he said "hello"');
    });

    it("handles unclosed attribute quote at stream end", () => {
      const parser = createParser();
      const results = collectAll(parser, ['<interpretation for="unclosed']);
      // Should not crash — flush emits as text
      expect(textOutput(results)).toContain("interpretation");
    });

    it("handles attribute with no value before >", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<interpretation selected>x</interpretation>"]);
      const blocks = customBlocks(results);
      expect(blocks[0].attrs).toEqual({ selected: "" });
    });

    it("handles only whitespace between tag name and >", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<think   >x</think>"]);
      expect(customBlocks(results)[0].content).toBe("x");
    });

    it("handles null bytes in content (doesn't crash)", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<think>a\0b</think>rest"]);
      expect(customBlocks(results)[0].content).toBe("a\0b");
    });

    it("handles tag that looks like HTML comment", () => {
      const parser = createParser();
      // <!-- is not a registered tag — passes through
      const results = collectAll(parser, ["<!-- comment -->"]);
      expect(textOutput(results)).toBe("<!-- comment -->");
    });

    it("handles CDATA-like content", () => {
      const parser = createParser();
      const results = collectAll(parser, ["<think><![CDATA[data]]></think>rest"]);
      expect(customBlocks(results)[0].content).toBe("<![CDATA[data]]>");
      expect(textOutput(results)).toBe("rest");
    });
  });

  describe("adversarial: property-based invariants", () => {
    /**
     * Core invariant: for any input string, the concatenation of all text
     * output + all custom block content equals the original input with
     * registered tags stripped.
     */
    function stripRegisteredTags(input: string, tagNames: string[]): string {
      let result = input;
      for (const tag of tagNames) {
        // Strip self-closing
        result = result.replace(new RegExp(`<${tag}(?:\\s[^>]*)?\\/>`, "g"), "");
        // Strip open/close pairs (greedy but sufficient for non-nested)
        result = result.replace(
          new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "g"),
          "",
        );
      }
      return result;
    }

    const testCases = [
      "plain text no tags",
      "<think>reasoning</think>answer",
      'prefix<interpretation for="b1">summary</interpretation>suffix',
      "<done/>text<done/>more<done/>",
      "<b>html</b><think>r</think><i>more</i>",
      "<think>has </b> and </i> inside</think>after",
      "x < y and <think>z > w</think>end",
      '<interpretation for="x" confidence="high">multi attr</interpretation>.',
      "<think></think><think></think>gap<think></think>",
      "no tags at all < > << >> just text",
      "<think>line1\nline2\nline3</think>done",
      '<debug-info channel="stderr">error output</debug-info>ok',
    ];

    for (const input of testCases) {
      it(`text output invariant for: "${input.slice(0, 50)}..."`, () => {
        const parser = createParser();
        const results = collectAll(parser, [input]);
        const stripped = stripRegisteredTags(input, [
          "think",
          "interpretation",
          "done",
          "debug-info",
        ]);
        expect(textOutput(results)).toBe(stripped);
      });
    }

    it("text output is identical regardless of chunk splitting", () => {
      const input =
        '<think>reasoning</think>middle<interpretation for="b">summary</interpretation>end';
      const singleChunk = createParser();
      const singleResult = collectAll(singleChunk, [input]);
      const singleText = textOutput(singleResult);
      const singleBlocks = customBlocks(singleResult);

      // Try multiple random splits
      for (let splits = 1; splits <= 5; splits++) {
        // Generate split positions
        const positions = Array.from({ length: splits }, (_, i) =>
          Math.floor(((i + 1) * input.length) / (splits + 1)),
        );

        const chunks: string[] = [];
        let prev = 0;
        for (const pos of positions) {
          chunks.push(input.slice(prev, pos));
          prev = pos;
        }
        chunks.push(input.slice(prev));

        const parser = createParser();
        const results = collectAll(parser, chunks);
        expect(textOutput(results)).toBe(singleText);
        expect(customBlocks(results)).toEqual(singleBlocks);
      }
    });

    it("custom block content + text output covers all non-tag chars", () => {
      const input = "A<think>B</think>C<done/>D<interpretation>E</interpretation>F";
      const parser = createParser();
      const results = collectAll(parser, [input]);

      const text = textOutput(results);
      const blockContent = customBlocks(results)
        .map((b) => b.content)
        .join("");

      // All non-tag characters should appear in either text or block content
      expect(text).toBe("ACDF");
      expect(blockContent).toBe("BE");
    });

    it("every byte boundary split for multi-tag input", () => {
      const input = "<think>r</think>t<done/>x<debug-info>d</debug-info>end";
      const singleParser = createParser();
      const singleResult = collectAll(singleParser, [input]);
      const expectedText = textOutput(singleResult);
      const expectedBlocks = customBlocks(singleResult);

      for (let i = 1; i < input.length; i++) {
        const parser = createParser();
        const results = collectAll(parser, [input.slice(0, i), input.slice(i)]);
        expect(textOutput(results)).toBe(expectedText);
        expect(customBlocks(results)).toEqual(expectedBlocks);
      }
    });

    it("every byte boundary for 3-way split", () => {
      const input = "<think>content</think>rest";
      const singleParser = createParser();
      const expected = collectAll(singleParser, [input]);
      const expectedText = textOutput(expected);
      const expectedBlocks = customBlocks(expected);

      for (let i = 1; i < input.length - 1; i++) {
        for (let j = i + 1; j < input.length; j++) {
          const parser = createParser();
          const results = collectAll(parser, [
            input.slice(0, i),
            input.slice(i, j),
            input.slice(j),
          ]);
          expect(textOutput(results)).toBe(expectedText);
          expect(customBlocks(results)).toEqual(expectedBlocks);
        }
      }
    });
  });

  describe("flush behavior", () => {
    it("returns empty array when nothing buffered", () => {
      const parser = createParser();
      expect(parser.flush()).toEqual([]);
    });

    it("flushes partial tag buffer as text", () => {
      const parser = createParser();
      const processed = parser.process(text("hello<thi"));
      const flushed = parser.flush();
      // "hello" emitted during process (char-by-char), "<thi" during flush
      const allText = textOutput([...processed, ...flushed]);
      expect(allText).toBe("hello<thi");
      // Flush specifically contains the buffered partial tag
      expect(textOutput(flushed)).toContain("<thi");
    });

    it("flushes unclosed content as custom block (best effort)", () => {
      const _parser = createParser();
      const onContent = vi.fn();
      const p2 = new StreamTagParser({ tags: { think: { onContent } } });
      p2.process(text("<think>partial content"));
      const _flushed = p2.flush();
      expect(onContent).toHaveBeenCalledWith("partial content", {});
    });
  });
});
