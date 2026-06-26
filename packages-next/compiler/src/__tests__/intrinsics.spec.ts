/**
 * Intrinsic-helper smoke — verifies each helper produces the expected
 * `RenderedTree`-fragment shape. These are pure functions; tests pin
 * the IR contract that adapter host-configs depend on.
 */

import { describe, expect, it } from "vitest";

import {
  codeBlock,
  headerBlock,
  jsonBlock,
  messageEntry,
  sectionEntry,
  textBlock,
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
