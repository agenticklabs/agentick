import { ThinkTagParser } from "../think-tag-parser.js";
import type { AdapterDelta } from "@agentick/core/model";

function text(delta: string): AdapterDelta {
  return { type: "text", delta };
}

function reasoning(delta: string): AdapterDelta {
  return { type: "reasoning", delta };
}

function collectAll(parser: ThinkTagParser, chunks: string[]): AdapterDelta[] {
  const results: AdapterDelta[] = [];
  for (const chunk of chunks) {
    results.push(...parser.process(text(chunk)));
  }
  results.push(...parser.flush());
  return results;
}

describe("ThinkTagParser", () => {
  let parser: ThinkTagParser;

  beforeEach(() => {
    parser = new ThinkTagParser();
  });

  describe("passthrough (no think tags)", () => {
    it("should pass text through unchanged", () => {
      const results = collectAll(parser, ["Hello, world!"]);
      expect(results).toEqual([text("Hello, world!")]);
    });

    it("should pass multiple text chunks through unchanged", () => {
      const results = collectAll(parser, ["Hello", ", ", "world!"]);
      expect(results).toEqual([text("Hello"), text(", "), text("world!")]);
    });

    it("should pass non-text deltas through unchanged", () => {
      const toolDelta: AdapterDelta = { type: "tool_call_start", id: "1", name: "test" };
      const results = parser.process(toolDelta);
      expect(results).toEqual([toolDelta]);
    });
  });

  describe("complete think block in single chunk", () => {
    it("should extract reasoning from a single chunk", () => {
      const results = collectAll(parser, ["<think>Let me think</think>Answer"]);
      expect(results).toEqual([reasoning("Let me think"), text("Answer")]);
    });

    it("should handle think block at start with trailing content", () => {
      const results = collectAll(parser, ["<think>reasoning here</think>the answer is 42"]);
      expect(results).toEqual([reasoning("reasoning here"), text("the answer is 42")]);
    });

    it("should handle text before think block", () => {
      const results = collectAll(parser, ["prefix <think>reasoning</think> suffix"]);
      expect(results).toEqual([text("prefix "), reasoning("reasoning"), text(" suffix")]);
    });
  });

  describe("tags split across chunks", () => {
    it("should handle <think> split: '<thi' + 'nk>content</think>'", () => {
      const results = collectAll(parser, ["<thi", "nk>content</think>"]);
      expect(results).toEqual([reasoning("content")]);
    });

    it("should handle <think> split: '<' + 'think>content</think>'", () => {
      const results = collectAll(parser, ["<", "think>content</think>"]);
      expect(results).toEqual([reasoning("content")]);
    });

    it("should handle <think> split: '<think' + '>content</think>'", () => {
      const results = collectAll(parser, ["<think", ">content</think>"]);
      expect(results).toEqual([reasoning("content")]);
    });

    it("should handle </think> split: '<think>content</thi' + 'nk>rest'", () => {
      const results = collectAll(parser, ["<think>content</thi", "nk>rest"]);
      expect(results).toEqual([reasoning("content"), text("rest")]);
    });

    it("should handle </think> split: '<think>content</' + 'think>rest'", () => {
      const results = collectAll(parser, ["<think>content</", "think>rest"]);
      expect(results).toEqual([reasoning("content"), text("rest")]);
    });

    it("should handle tag split one char at a time", () => {
      const input = "<think>hello</think>world";
      const results = collectAll(
        parser,
        input.split("").map((c) => c),
      );
      // Each char outside tags is emitted individually since it can't accumulate
      const text_chars = "world".split("").map((c) => text(c));
      const reasoning_chars = "hello".split("").map((c) => reasoning(c));
      expect(results).toEqual([...reasoning_chars, ...text_chars]);
    });
  });

  describe("multiple think blocks", () => {
    it("should handle two think blocks", () => {
      const results = collectAll(parser, ["<think>first</think>between<think>second</think>end"]);
      expect(results).toEqual([
        reasoning("first"),
        text("between"),
        reasoning("second"),
        text("end"),
      ]);
    });

    it("should handle two think blocks across chunks", () => {
      const results = collectAll(parser, [
        "<think>first</think>",
        "gap",
        "<think>second</think>",
        "tail",
      ]);
      expect(results).toEqual([reasoning("first"), text("gap"), reasoning("second"), text("tail")]);
    });
  });

  describe("empty think block", () => {
    it("should handle <think></think> with no content", () => {
      const results = collectAll(parser, ["<think></think>answer"]);
      expect(results).toEqual([text("answer")]);
    });
  });

  describe("partial < at chunk boundary that isn't a tag", () => {
    it("should emit '<' when followed by non-tag content", () => {
      const results = collectAll(parser, ["hello <", "b>bold</b> world"]);
      // The '<' is buffered because it could be '<think>', but 'b>' doesn't match
      expect(results).toEqual([text("hello "), text("<b>bold</b> world")]);
    });

    it("should handle '<th' that isn't '<think>'", () => {
      const results = collectAll(parser, ["check <th", "is out"]);
      // '<th' is buffered as potential '<think>' prefix, but 'is' doesn't continue it
      expect(results).toEqual([text("check "), text("<this out")]);
    });

    it("should handle angle bracket in regular text", () => {
      const results = collectAll(parser, ["x < y and y > z"]);
      expect(results).toEqual([text("x < y and y > z")]);
    });
  });

  describe("adversarial: nested tags", () => {
    it("should treat inner <think> as reasoning text (no nesting)", () => {
      const results = collectAll(parser, ["<think>outer<think>inner</think>after"]);
      // State machine: sees first <think>, enters reasoning mode
      // In reasoning mode, looks for </think>. The inner <think> is just text.
      // Finds </think> after "inner" → reasoning = "outer<think>inner"
      expect(results).toEqual([reasoning("outer<think>inner"), text("after")]);
    });
  });

  describe("adversarial: unclosed tag", () => {
    it("should flush remaining buffer as reasoning on stream end", () => {
      const results = collectAll(parser, ["<think>this never closes"]);
      expect(results).toEqual([reasoning("this never closes")]);
    });

    it("should flush remaining text on stream end (no tags)", () => {
      const results = collectAll(parser, ["just text"]);
      expect(results).toEqual([text("just text")]);
    });
  });

  describe("adversarial: think in non-text deltas (tool calls)", () => {
    it("should not parse think tags in tool_call_delta", () => {
      const toolDelta: AdapterDelta = {
        type: "tool_call_delta",
        id: "call_1",
        delta: '{"content":"<think>reasoning</think>"}',
      };
      const results = parser.process(toolDelta);
      expect(results).toEqual([toolDelta]);
    });
  });

  describe("flush behavior", () => {
    it("should return empty array when nothing buffered", () => {
      expect(parser.flush()).toEqual([]);
    });

    it("should flush partial tag buffer as current mode", () => {
      // Buffer '<thi' which looks like potential <think> prefix
      parser.process(text("hello<thi"));
      const flushed = parser.flush();
      expect(flushed).toEqual([text("<thi")]);
    });

    it("should flush reasoning content when inside unclosed think tag", () => {
      // process() drains eagerly, so "partial reasoning" is emitted during process()
      const processed = parser.process(text("<think>partial reasoning"));
      expect(processed).toEqual([reasoning("partial reasoning")]);
      // flush() has nothing left
      expect(parser.flush()).toEqual([]);
    });

    it("should flush partial close tag buffered as reasoning", () => {
      // '</thi' is buffered as potential '</think>' prefix
      parser.process(text("<think>content</thi"));
      const flushed = parser.flush();
      // The buffered '</thi' is flushed as reasoning (we're inside a think block)
      expect(flushed).toEqual([reasoning("</thi")]);
    });
  });

  describe("edge cases", () => {
    it("should handle empty string input", () => {
      const results = parser.process(text(""));
      expect(results).toEqual([]);
    });

    it("should handle think tag with only whitespace", () => {
      const results = collectAll(parser, ["<think>   </think>answer"]);
      expect(results).toEqual([reasoning("   "), text("answer")]);
    });

    it("should handle consecutive close tags", () => {
      const results = collectAll(parser, ["<think>x</think></think>tail"]);
      // First </think> closes the block. Second </think> is text.
      expect(results).toEqual([reasoning("x"), text("</think>tail")]);
    });

    it("should handle close tag without open tag", () => {
      const results = collectAll(parser, ["no open </think> here"]);
      // In text mode, looking for <think> — </think> is just text
      expect(results).toEqual([text("no open </think> here")]);
    });
  });
});
