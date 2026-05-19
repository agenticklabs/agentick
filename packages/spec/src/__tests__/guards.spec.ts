import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AudioBlock,
  CodeBlock,
  ContentBlock,
  ContextEntry,
  EventBlock,
  EventEnvelope,
  ExecutorTerminal,
  ImageBlock,
  LifecycleEvent,
  MediaBlock,
  MessageEntry,
  ProtocolEvent,
  RenderedTree,
  SectionEntry,
  TerminalEvent,
  TextBlock,
  ToolUseBlock,
} from "../index.js";
import {
  hasFeature,
  isAudioBlock,
  isCanceled,
  isCodeBlock,
  isDataBlock,
  isDeltaEvent,
  isEventBlock,
  isExecutorFailed,
  isExecutorSucceeded,
  isFailed,
  isFailedTerminal,
  isImageBlock,
  isJsonBlock,
  isLifecycleError,
  isLifecycleTickEnd,
  isLifecycleTickStart,
  isMediaBlock,
  isMessageEntry,
  isPhase,
  isSectionEntry,
  isStateChangeBlock,
  isSucceeded,
  isSucceededTerminal,
  isSystemEventBlock,
  isTextBlock,
  isToolUseBlock,
  isUserActionBlock,
} from "../guards/index.js";

describe("guards — ContentBlock narrowing", () => {
  it("isTextBlock narrows to TextBlock", () => {
    const block: ContentBlock = { type: "text", text: "hi" };
    if (isTextBlock(block)) {
      expectTypeOf(block).toEqualTypeOf<TextBlock>();
      expect(block.text).toBe("hi");
    }
  });

  it("isImageBlock narrows to ImageBlock", () => {
    const block: ContentBlock = {
      type: "image",
      source: { type: "url", url: "https://x" },
    };
    if (isImageBlock(block)) {
      expectTypeOf(block).toEqualTypeOf<ImageBlock>();
    }
  });

  it("isToolUseBlock narrows to ToolUseBlock", () => {
    const block: ContentBlock = {
      type: "tool_use",
      toolUseId: "tu",
      name: "echo",
      input: {},
    };
    if (isToolUseBlock(block)) {
      expectTypeOf(block).toEqualTypeOf<ToolUseBlock>();
    }
  });

  it("isMediaBlock narrows to MediaBlock union", () => {
    const blocks: ContentBlock[] = [
      { type: "image", source: { type: "url", url: "x" } },
      { type: "document", source: { type: "url", url: "x" } },
      { type: "audio", source: { type: "url", url: "x" } },
      { type: "video", source: { type: "url", url: "x" } },
      { type: "text", text: "not media" },
    ];
    const media = blocks.filter(isMediaBlock);
    expect(media).toHaveLength(4);
    if (isMediaBlock(media[0]!)) {
      expectTypeOf(media[0]!).toEqualTypeOf<MediaBlock>();
    }
  });

  it("isDataBlock catches json/xml/csv/html/code", () => {
    const samples: ContentBlock[] = [
      { type: "json", data: {} },
      { type: "xml", text: "<a/>" },
      { type: "csv", text: "a,b" },
      { type: "html", text: "<p/>" },
      { type: "code", text: "x", language: "typescript" },
      { type: "text", text: "nope" },
    ];
    expect(samples.filter(isDataBlock)).toHaveLength(5);
  });

  it("isEventBlock catches user_action/system_event/state_change", () => {
    const samples: ContentBlock[] = [
      { type: "user_action", action: "a" },
      { type: "system_event", event: "e" },
      { type: "state_change", entity: "x", from: 1, to: 2 },
      { type: "text", text: "nope" },
    ];
    const events = samples.filter(isEventBlock);
    expect(events).toHaveLength(3);
    expectTypeOf(events[0]!).toEqualTypeOf<EventBlock>();
  });

  it("individual variant guards", () => {
    const audio: ContentBlock = { type: "audio", source: { type: "url", url: "x" } };
    if (isAudioBlock(audio)) {
      expectTypeOf(audio).toEqualTypeOf<AudioBlock>();
    }
    const code: ContentBlock = { type: "code", text: "", language: "go" };
    if (isCodeBlock(code)) {
      expectTypeOf(code).toEqualTypeOf<CodeBlock>();
    }
    expect(isJsonBlock({ type: "json", data: 1 })).toBe(true);
    expect(isUserActionBlock({ type: "user_action", action: "x" })).toBe(true);
    expect(isSystemEventBlock({ type: "system_event", event: "x" })).toBe(true);
    expect(isStateChangeBlock({ type: "state_change", entity: "x", from: 1, to: 2 })).toBe(true);
  });
});

describe("guards — ContextEntry narrowing", () => {
  it("isMessageEntry / isSectionEntry narrow correctly", () => {
    const entries: ContextEntry[] = [
      { kind: "message", role: "user", content: [{ type: "text", text: "hi" }] },
      { kind: "section", id: "s.intro", content: [] },
    ];
    const messages = entries.filter(isMessageEntry);
    const sections = entries.filter(isSectionEntry);
    expect(messages).toHaveLength(1);
    expect(sections).toHaveLength(1);
    expectTypeOf(messages[0]!).toEqualTypeOf<MessageEntry>();
    expectTypeOf(sections[0]!).toEqualTypeOf<SectionEntry>();
  });
});

describe("guards — EventEnvelope phase + outcome narrowing", () => {
  const baseEvent: EventEnvelope = {
    id: "e1",
    surface: "session",
    name: "session:test",
    phase: "terminal",
    outcome: "succeeded",
    timestamp: 0,
    scope: {},
  };

  it("isPhase narrows phase", () => {
    if (isPhase(baseEvent, "terminal")) {
      expectTypeOf(baseEvent.phase).toEqualTypeOf<"terminal">();
    }
  });

  it("isSucceededTerminal narrows phase + outcome", () => {
    expect(isSucceededTerminal(baseEvent)).toBe(true);
    const otherwise: EventEnvelope = { ...baseEvent, outcome: "failed" };
    expect(isSucceededTerminal(otherwise)).toBe(false);
    expect(isFailedTerminal(otherwise)).toBe(true);
  });

  it("phase-only guards work", () => {
    const delta: ProtocolEvent = { ...baseEvent, phase: "delta", outcome: undefined };
    expect(isDeltaEvent(delta)).toBe(true);
    expect(isDeltaEvent(baseEvent)).toBe(false);
  });
});

describe("guards — TerminalEvent + ExecutorTerminal outcomes", () => {
  it("isSucceeded / isFailed / isCanceled narrow TerminalEvent", () => {
    const ok: TerminalEvent<string, Error> = { outcome: "succeeded", result: "x" };
    const bad: TerminalEvent<string, Error> = { outcome: "failed", error: new Error("y") };
    const cancel: TerminalEvent<string, Error> = { outcome: "canceled", reason: "z" };

    if (isSucceeded(ok)) expectTypeOf(ok.result).toBeString();
    if (isFailed(bad)) expectTypeOf(bad.error).toEqualTypeOf<Error>();
    if (isCanceled(cancel)) expectTypeOf(cancel.reason).toEqualTypeOf<string | undefined>();
  });

  it("isExecutorSucceeded / isExecutorFailed narrow ExecutorTerminal", () => {
    const ok: ExecutorTerminal = {
      outcome: "succeeded",
      result: { specVersion: "2026-05-01", output: [] },
    };
    const fail: ExecutorTerminal = {
      outcome: "failed",
      error: { _tag: "ProviderTimeout", timeoutMs: 1000 },
    };
    expect(isExecutorSucceeded(ok)).toBe(true);
    expect(isExecutorFailed(fail)).toBe(true);
  });
});

describe("guards — LifecycleEvent narrowing", () => {
  it("each kind has its own guard", () => {
    const ts: LifecycleEvent = { kind: "tick-start", tickId: "t1" };
    const te: LifecycleEvent = { kind: "tick-end", tickId: "t1", result: 0 };
    const err: LifecycleEvent = {
      kind: "error",
      phase: "tick",
      error: { name: "E", message: "x" },
    };
    expect(isLifecycleTickStart(ts)).toBe(true);
    expect(isLifecycleTickEnd(te)).toBe(true);
    expect(isLifecycleError(err)).toBe(true);
    expect(isLifecycleTickStart(te)).toBe(false);
  });
});

describe("guards — hasFeature", () => {
  it("returns true when feature is in tree.features", () => {
    const tree: RenderedTree = {
      specVersion: "2026-05-01",
      features: ["sections", "tool-declarations"],
      context: { entries: [] },
    };
    expect(hasFeature(tree, "sections")).toBe(true);
    expect(hasFeature(tree, "outputs")).toBe(false);
  });

  it("returns false when features is undefined", () => {
    const tree: RenderedTree = {
      specVersion: "2026-05-01",
      context: { entries: [] },
    };
    expect(hasFeature(tree, "sections")).toBe(false);
  });
});

describe("declaration guards", () => {
  it("isToolDeclaration narrows on shape", async () => {
    const { isToolDeclaration } = await import("../guards/index.js");
    expect(
      isToolDeclaration({
        id: "t",
        name: "calc",
        description: "x",
        inputSchema: { type: "object" },
        handlerRef: "h.calc",
      }),
    ).toBe(true);
    expect(isToolDeclaration({ name: "calc" })).toBe(false);
    expect(isToolDeclaration(null)).toBe(false);
  });

  it("isResourceDeclaration", async () => {
    const { isResourceDeclaration } = await import("../guards/index.js");
    expect(isResourceDeclaration({ id: "r", uri: "file://x" })).toBe(true);
    expect(isResourceDeclaration({ id: "r" })).toBe(false);
  });

  it("isOutputDeclaration", async () => {
    const { isOutputDeclaration } = await import("../guards/index.js");
    expect(isOutputDeclaration({ id: "o", mode: "json" })).toBe(true);
    expect(isOutputDeclaration({ id: "o" })).toBe(false);
  });

  it("isMCPDeclaration", async () => {
    const { isMCPDeclaration } = await import("../guards/index.js");
    expect(
      isMCPDeclaration({ id: "m", transport: { kind: "stdio", command: "x" } }),
    ).toBe(true);
    expect(isMCPDeclaration({ id: "m" })).toBe(false);
  });
});

describe("semantic content guards", () => {
  it("isSemanticContent detects the semanticNode sidecar", async () => {
    const { isSemanticContent } = await import("../guards/index.js");
    expect(
      isSemanticContent({
        type: "text",
        text: "",
        semanticNode: { children: [{ text: "x" }] },
      } as ContentBlock),
    ).toBe(true);
    expect(isSemanticContent({ type: "text", text: "hello" })).toBe(false);
  });

  it("isFormatterRef accepts well-shaped refs", async () => {
    const { isFormatterRef } = await import("../guards/index.js");
    expect(isFormatterRef({ id: "formatter.markdown", format: "markdown" })).toBe(true);
    expect(isFormatterRef({ id: "x" })).toBe(true);
    expect(isFormatterRef({ format: "markdown" })).toBe(false);
    expect(isFormatterRef(null)).toBe(false);
  });
});
