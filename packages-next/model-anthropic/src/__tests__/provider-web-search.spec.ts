/**
 * Pass A — Anthropic OPTIMISTIC provider stamping of provider-executed server
 * tools (web search).
 *
 * The adapter surfaces `server_tool_use` + `web_search_tool_result` content
 * blocks (and `web_search_result_location` citations) that the wire delivers
 * but the pinned `@anthropic-ai/sdk@0.39.0` does NOT type. The result is folded
 * into the normalized `output` as a `tool_result` block stamped
 * `executedBy: "provider:anthropic"`, and the request-half `server_tool_use`
 * block is EXCLUDED from `toolCalls` (never re-dispatched by the framework).
 *
 * FIXTURE-TYPING EXCEPTION (documented deviation from the SDK-typed-fixture
 * rule): these shapes are absent from the SDK's `ContentBlock` / `TextCitation`
 * unions, so the fixtures below CANNOT be typed against the SDK. They are typed
 * against the adapter's LOCAL wire interfaces
 * (`Anthropic*Wire`, exported from `../anthropic-adapter.js` for exactly this
 * reason) — the honest single source of truth until the SDK types land.
 */

import { describe, expect, it } from "vitest";

import type { ToolResultBlock } from "@agentick/spec-next";
import type {
  Message as AnthropicMessage,
  TextCitation,
} from "@anthropic-ai/sdk/resources/messages";

import {
  anthropic,
  type AnthropicServerToolUseBlockWire,
  type AnthropicWebSearchResultLocationCitationWire,
  type AnthropicWebSearchToolResultBlockWire,
} from "../anthropic-adapter.js";

/**
 * Assemble a raw Anthropic `Message` from a mix of SDK-typed and wire-only
 * blocks. Wire-only blocks are typed against the adapter's local interfaces,
 * then widened to the SDK content-element type at the boundary (the SDK union
 * cannot express them — see file header).
 */
function mkMessage(blocks: readonly unknown[]): AnthropicMessage {
  return {
    id: "msg_websearch",
    type: "message",
    role: "assistant",
    model: "claude-3-5-sonnet-latest",
    content: blocks as AnthropicMessage["content"],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 8,
      output_tokens: 4,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    },
  } as AnthropicMessage;
}

const serverToolUse: AnthropicServerToolUseBlockWire = {
  type: "server_tool_use",
  id: "srvtoolu_1",
  name: "web_search",
  input: { query: "agentick framework" },
};

const webSearchResult: AnthropicWebSearchToolResultBlockWire = {
  type: "web_search_tool_result",
  tool_use_id: "srvtoolu_1",
  content: [
    { type: "web_search_result", url: "https://a.example/one", title: "One" },
    { type: "web_search_result", url: "https://b.example/two", title: "Two" },
    // Repeat a URL — the turn-scoped interner must dedupe it to one Source id.
    { type: "web_search_result", url: "https://a.example/one", title: "One" },
  ],
};

describe("anthropic() — provider-executed web search (Pass A)", () => {
  it("EXCLUDES the server_tool_use request-half from toolCalls", () => {
    const result = anthropic("claude-3-5-sonnet-latest").normalize(
      mkMessage([serverToolUse, webSearchResult]),
    );
    // Structural exclusion: `server_tool_use` !== `tool_use`. No dispatchable
    // call leaks out, so the framework's tool executor never re-runs it.
    expect(result.toolCalls ?? []).toEqual([]);
  });

  it("does NOT emit the server_tool_use as a canonical tool_use block", () => {
    const result = anthropic().normalize(mkMessage([serverToolUse, webSearchResult]));
    expect(result.output.some((b) => b.type === "tool_use")).toBe(false);
  });

  it("surfaces the result as a tool_result stamped provider:anthropic", () => {
    const result = anthropic().normalize(mkMessage([serverToolUse, webSearchResult]));
    const toolResult = result.output.find((b) => b.type === "tool_result") as
      | ToolResultBlock
      | undefined;
    expect(toolResult).toBeDefined();
    expect(toolResult!.executedBy).toBe("provider:anthropic");
    expect(toolResult!.toolUseId).toBe("srvtoolu_1");
    // Name is recovered from the correlated server_tool_use request half.
    expect(toolResult!.name).toBe("web_search");
    expect(toolResult!.isError ?? false).toBe(false);
  });

  it("maps each hit to a text block with an interned, deduped Source + citation", () => {
    const result = anthropic().normalize(mkMessage([serverToolUse, webSearchResult]));
    const toolResult = result.output.find((b) => b.type === "tool_result") as ToolResultBlock;
    // Three hits in → three text blocks.
    expect(toolResult.content).toHaveLength(3);
    expect(toolResult.content.every((b) => b.type === "text")).toBe(true);
    // Block-level roll-up: two DISTINCT urls → two deduped sources.
    expect(toolResult.sources).toHaveLength(2);
    const urls = (toolResult.sources ?? []).map((s) => s.url).sort();
    expect(urls).toEqual(["https://a.example/one", "https://b.example/two"]);
    // First + third hit share a url → same interned Source id.
    const first = toolResult.content[0]!;
    const third = toolResult.content[2]!;
    expect(first.citations?.[0]?.sourceId).toBe(third.citations?.[0]?.sourceId);
  });

  it("folds the error variant to an isError tool_result", () => {
    const errored: AnthropicWebSearchToolResultBlockWire = {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
    };
    const result = anthropic().normalize(mkMessage([serverToolUse, errored]));
    const toolResult = result.output.find((b) => b.type === "tool_result") as ToolResultBlock;
    expect(toolResult.isError).toBe(true);
    expect(toolResult.executedBy).toBe("provider:anthropic");
    expect((toolResult.content[0] as { text: string }).text).toContain("max_uses_exceeded");
  });

  it("defaults the tool name to web_search when the request half is absent", () => {
    // A result block with no preceding server_tool_use (e.g. truncated turn).
    const result = anthropic().normalize(mkMessage([webSearchResult]));
    const toolResult = result.output.find((b) => b.type === "tool_result") as ToolResultBlock;
    expect(toolResult.name).toBe("web_search");
  });

  it("maps web_search_result_location citations onto text blocks by URL", () => {
    const citation: AnthropicWebSearchResultLocationCitationWire = {
      type: "web_search_result_location",
      url: "https://a.example/one",
      title: "One",
      cited_text: "the framework is lean",
      encrypted_index: "idx",
    };
    const textBlock = {
      type: "text",
      text: "Agentick is a framework.",
      // Wire-only citation variant; widen to the SDK citation array type at
      // the boundary (the SDK `TextCitation` union cannot express it).
      citations: [citation] as unknown as TextCitation[],
    };
    const result = anthropic().normalize(mkMessage([serverToolUse, webSearchResult, textBlock]));
    const text = result.output.find(
      (b) => b.type === "text" && b.text === "Agentick is a framework.",
    );
    expect(text).toBeDefined();
    expect(text!.citations?.[0]?.citedText).toBe("the framework is lean");
    // Interned by URL — shares the Source with the same URL from the result set.
    const citedSourceId = text!.citations?.[0]?.sourceId;
    expect(
      text!.sources?.some((s) => s.id === citedSourceId && s.url === "https://a.example/one"),
    ).toBe(true);
  });
});
