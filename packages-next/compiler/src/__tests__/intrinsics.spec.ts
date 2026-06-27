/**
 * Intrinsic-helper smoke — verifies each helper produces the expected
 * `RenderedTree`-fragment shape. These are pure functions; tests pin
 * the IR contract that adapter host-configs depend on.
 */

import { describe, expect, it } from "vitest";

import {
  audioBlock,
  codeBlock,
  csvBlock,
  customBlock,
  documentBlock,
  headerBlock,
  htmlBlock,
  imageBlock,
  jsonBlock,
  messageEntry,
  reasoningBlock,
  sectionEntry,
  stateChangeBlock,
  systemEventBlock,
  textBlock,
  userActionBlock,
  videoBlock,
  xmlBlock,
} from "../index.js";

describe("intrinsic helpers — block-level", () => {
  it("textBlock emits {type:'text'}", () => {
    expect(textBlock("hello")).toEqual({ type: "text", text: "hello" });
  });

  it("headerBlock emits a semantic heading node (formatter-syntax-agnostic)", () => {
    expect(headerBlock(1, "Title")).toEqual({
      type: "text",
      text: "",
      semanticNode: { semantic: "heading", props: { level: 1 }, children: [{ text: "Title" }] },
    });
    expect(headerBlock(3, "Sub")).toEqual({
      type: "text",
      text: "",
      semanticNode: { semantic: "heading", props: { level: 3 }, children: [{ text: "Sub" }] },
    });
  });

  it("codeBlock includes language when provided", () => {
    expect(codeBlock("x = 1", "python")).toEqual({
      type: "code",
      text: "x = 1",
      language: "python",
    });
  });

  it("codeBlock defaults language to 'other' when undefined", () => {
    expect(codeBlock("x")).toEqual({ type: "code", text: "x", language: "other" });
  });

  it("jsonBlock carries arbitrary data verbatim", () => {
    const data = { a: 1, b: [2, 3] };
    expect(jsonBlock(data)).toEqual({ type: "json", data });
  });
});

describe("intrinsic helpers — context entries", () => {
  it("sectionEntry composes id + content", () => {
    const content = [textBlock("body")];
    expect(sectionEntry({ id: "intro" }, content)).toEqual({
      kind: "section",
      id: "intro",
      content,
    });
  });

  it("sectionEntry defaults id to 'anonymous' when omitted", () => {
    expect(sectionEntry({}, []).id).toBe("anonymous");
  });

  it("sectionEntry surfaces title when given", () => {
    expect(sectionEntry({ id: "x", title: "Intro" }, []).title).toBe("Intro");
  });

  it("sectionEntry stamps audience + priority into metadata", () => {
    const e = sectionEntry({ id: "x", audience: "model", priority: 7 }, []);
    expect(e.metadata).toEqual({ audience: "model", priority: 7 });
  });

  it("sectionEntry omits metadata key when no audience/priority", () => {
    const e = sectionEntry({ id: "x" }, []);
    expect(e.metadata).toBeUndefined();
  });

  it("messageEntry composes role + content + optional id", () => {
    const content = [textBlock("hi")];
    expect(messageEntry({ role: "user" }, content)).toEqual({
      kind: "message",
      role: "user",
      content,
    });
    expect(messageEntry({ role: "user", id: "m1" }, content)).toEqual({
      kind: "message",
      role: "user",
      content,
      id: "m1",
    });
  });
});

describe("intrinsic helpers — media blocks", () => {
  const src = { type: "url", url: "https://example.com/x" } as const;

  it("imageBlock composes source + optional metadata", () => {
    expect(imageBlock({ source: src })).toEqual({ type: "image", source: src });
    expect(imageBlock({ source: src, mimeType: "image/png", altText: "alt" })).toEqual({
      type: "image",
      source: src,
      mimeType: "image/png",
      altText: "alt",
    });
  });

  it("audioBlock includes transcript when provided", () => {
    expect(audioBlock({ source: src, transcript: "hello" })).toEqual({
      type: "audio",
      source: src,
      transcript: "hello",
    });
  });

  it("videoBlock includes transcript when provided", () => {
    expect(videoBlock({ source: src })).toEqual({ type: "video", source: src });
  });

  it("documentBlock includes title when provided", () => {
    expect(documentBlock({ source: src, title: "Whitepaper" })).toEqual({
      type: "document",
      source: src,
      title: "Whitepaper",
    });
  });
});

describe("intrinsic helpers — textual variants", () => {
  it("xmlBlock, htmlBlock pass text verbatim", () => {
    expect(xmlBlock("<root/>")).toEqual({ type: "xml", text: "<root/>" });
    expect(htmlBlock("<p>x</p>")).toEqual({ type: "html", text: "<p>x</p>" });
  });

  it("csvBlock includes headers when provided", () => {
    expect(csvBlock("a,b\n1,2", ["a", "b"])).toEqual({
      type: "csv",
      text: "a,b\n1,2",
      headers: ["a", "b"],
    });
    expect(csvBlock("x")).toEqual({ type: "csv", text: "x" });
  });

  it("reasoningBlock surfaces signature + isRedacted", () => {
    expect(reasoningBlock({ text: "thinking…" })).toEqual({
      type: "reasoning",
      text: "thinking…",
    });
    expect(reasoningBlock({ text: "[redacted]", isRedacted: true, signature: "sig" })).toEqual({
      type: "reasoning",
      text: "[redacted]",
      isRedacted: true,
      signature: "sig",
    });
  });
});

describe("intrinsic helpers — event blocks", () => {
  it("userActionBlock requires action; passes optional fields", () => {
    expect(userActionBlock({ action: "click", target: "submit" })).toEqual({
      type: "user_action",
      action: "click",
      target: "submit",
    });
  });

  it("systemEventBlock requires event; passes optional source + data", () => {
    expect(systemEventBlock({ event: "session.started", source: "gateway" })).toEqual({
      type: "system_event",
      event: "session.started",
      source: "gateway",
    });
  });

  it("stateChangeBlock requires entity/from/to; passes optional field/trigger", () => {
    expect(
      stateChangeBlock({
        entity: "task",
        field: "status",
        from: "pending",
        to: "completed",
        trigger: "user",
      }),
    ).toEqual({
      type: "state_change",
      entity: "task",
      field: "status",
      from: "pending",
      to: "completed",
      trigger: "user",
    });
  });
});

describe("intrinsic helpers — customBlock", () => {
  it("composes tag/content/attrs/selfClosing", () => {
    expect(customBlock({ tag: "recipe", content: "Stir." })).toEqual({
      type: "custom",
      tag: "recipe",
      content: "Stir.",
      attrs: {},
    });
    expect(
      customBlock({
        tag: "recipe",
        content: "Stir.",
        attrs: { difficulty: "easy" },
        selfClosing: false,
      }),
    ).toEqual({
      type: "custom",
      tag: "recipe",
      content: "Stir.",
      attrs: { difficulty: "easy" },
      selfClosing: false,
    });
  });
});
