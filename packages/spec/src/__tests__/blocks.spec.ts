import { describe, expect, it } from "vitest";

import {
  code,
  custom,
  document,
  envelope,
  image,
  json,
  source,
  stateChange,
  text,
  toolResult,
  toolUse,
} from "../blocks/index.js";
import { isTextBlock, isToolResultBlock } from "../guards/index.js";

describe("block constructors", () => {
  it("build exactly the wire shape — no undefined keys, the narrow type", () => {
    expect(text("hi")).toEqual({ type: "text", text: "hi" });
    expect(text("hi", { id: undefined, summary: undefined })).toEqual({ type: "text", text: "hi" });
    expect(text("hi", { id: "b1", cache: { type: "ephemeral" } })).toEqual({
      type: "text",
      text: "hi",
      id: "b1",
      cache: { type: "ephemeral" },
    });
    expect(isTextBlock(text("x"))).toBe(true);
  });

  it("take required fields positionally and everything else through the bag", () => {
    expect(code("x", "ts")).toEqual({ type: "code", text: "x", language: "ts" });
    expect(json({ a: 1 })).toEqual({ type: "json", data: { a: 1 } });
    expect(json({ a: 1 }, { text: '{"a":1}' })).toEqual({
      type: "json",
      data: { a: 1 },
      text: '{"a":1}',
    });
    expect(image(source.url("https://x/a.png"), { altText: "a" })).toEqual({
      type: "image",
      source: { type: "url", url: "https://x/a.png" },
      altText: "a",
    });
    expect(
      document(source.reference("f1", { fileName: "a.pdf", size: 3 }), { title: "A" }),
    ).toEqual({
      type: "document",
      source: { type: "reference", fileId: "f1", fileName: "a.pdf", size: 3 },
      title: "A",
    });
    expect(stateChange("job", "open", "closed", { field: "status" })).toEqual({
      type: "state_change",
      entity: "job",
      from: "open",
      to: "closed",
      field: "status",
    });
  });

  it("build a tool result from what the tool returned — a string, blocks, or an envelope", () => {
    expect(toolUse("c1", "query", { a: 1 })).toEqual({
      type: "tool_use",
      toolUseId: "c1",
      name: "query",
      input: { a: 1 },
    });
    expect(toolResult("c1", "query", "3 rows")).toEqual({
      type: "tool_result",
      toolUseId: "c1",
      name: "query",
      content: [{ type: "text", text: "3 rows" }],
    });
    const blocks = [json({ rows: 3 })];
    expect(toolResult("c1", "query", blocks).content).toBe(blocks);
    const fromEnvelope = toolResult(
      "c1",
      "query",
      envelope("boom", { isError: true, structuredContent: { code: 7 } }),
    );
    expect(fromEnvelope).toEqual({
      type: "tool_result",
      toolUseId: "c1",
      name: "query",
      content: [{ type: "text", text: "boom" }],
      isError: true,
    });
    expect(isToolResultBlock(fromEnvelope)).toBe(true);
    expect(envelope([json({ rows: 3 })], { structuredContent: { rows: 3 } })).toEqual({
      content: [{ type: "json", data: { rows: 3 } }],
      structuredContent: { rows: 3 },
    });
  });

  it("self-close a custom with no content, unless told otherwise", () => {
    expect(custom("file-ref", { id: "f1" })).toEqual({
      type: "custom",
      tag: "file-ref",
      attrs: { id: "f1" },
      content: "",
      selfClosing: true,
    });
    expect(custom("note", {}, "body")).toMatchObject({ content: "body", selfClosing: false });
    expect(custom("empty", {}, "", { selfClosing: false })).toMatchObject({ selfClosing: false });
  });
});
