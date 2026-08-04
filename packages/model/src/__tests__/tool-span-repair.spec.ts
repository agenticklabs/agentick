/**
 * The grammar rule, and the reason it is enforced here rather than trusted to
 * whatever cut the timeline: every path that produces half a pair is a filter or
 * an eviction that had no idea it was doing it.
 *
 * The tests care most about the parts NEXT to a pruned one — a repair that takes
 * the assistant's prose down with an unanswered call has traded a 400 for a
 * silently worse prompt.
 */

import { describe, expect, it } from "vitest";
import type { LanguageModelMessage, LanguageModelMessagePart } from "@agentick/spec";

import { repairToolSpans } from "../tool-span-repair.js";

const text = (t: string): LanguageModelMessagePart =>
  ({ type: "text", text: t }) as LanguageModelMessagePart;
const call = (id: string): LanguageModelMessagePart =>
  ({ type: "tool_use", id, name: "search", input: {} }) as LanguageModelMessagePart;
const result = (toolUseId: string): LanguageModelMessagePart =>
  ({ type: "tool_result", toolUseId, content: [] }) as LanguageModelMessagePart;

const msg = (role: string, content: readonly LanguageModelMessagePart[]): LanguageModelMessage =>
  ({ role, content }) as unknown as LanguageModelMessage;

const roles = (messages: readonly LanguageModelMessage[]): string[] => messages.map((m) => m.role);
const types = (message: LanguageModelMessage | undefined): string[] =>
  (message?.content ?? []).map((p) => p.type);

describe("repairToolSpans", () => {
  it("returns the input by reference when every call is answered", () => {
    const messages = [
      msg("user", [text("find it")]),
      msg("assistant", [text("Looking."), call("c1")]),
      msg("tool", [result("c1")]),
    ];
    const out = repairToolSpans(messages);
    expect(out.messages).toBe(messages);
    expect(out.pruned).toEqual([]);
  });

  it("prunes a tool_result whose tool_use was filtered away", () => {
    const out = repairToolSpans([
      msg("user", [text("find it")]),
      msg("tool", [result("c1")]),
      msg("assistant", [text("Found it.")]),
    ]);
    expect(roles(out.messages)).toEqual(["user", "assistant"]);
    expect(out.pruned).toHaveLength(1);
    expect(out.pruned[0]).toMatchObject({ end: "close", toolUseId: "c1" });
  });

  it("prunes a tool_use nothing answers", () => {
    const out = repairToolSpans([
      msg("assistant", [text("Looking."), call("c1")]),
      msg("user", [text("never mind")]),
    ]);
    expect(roles(out.messages)).toEqual(["assistant", "user"]);
    expect(out.pruned).toMatchObject([{ end: "open", toolUseId: "c1" }]);
  });

  it("keeps the assistant's prose when its call is pruned", () => {
    const out = repairToolSpans([msg("assistant", [text("Looking."), call("c1")])]);
    expect(types(out.messages[0])).toEqual(["text"]);
  });

  it("drops a message it empties, and only that message", () => {
    const out = repairToolSpans([
      msg("user", [text("go")]),
      msg("assistant", [call("c1")]),
      msg("assistant", [text("done")]),
    ]);
    expect(roles(out.messages)).toEqual(["user", "assistant"]);
    expect(types(out.messages[1])).toEqual(["text"]);
  });

  it("pairs by id across the projection, not by adjacency", () => {
    // Parallel calls: two in one turn, results interleaved with other content.
    const messages = [
      msg("assistant", [call("c1"), call("c2")]),
      msg("tool", [result("c2")]),
      msg("tool", [result("c1")]),
    ];
    expect(repairToolSpans(messages).messages).toBe(messages);
  });

  it("prunes only the unanswered half of a parallel call", () => {
    const out = repairToolSpans([
      msg("assistant", [call("c1"), call("c2")]),
      msg("tool", [result("c1")]),
    ]);
    expect(types(out.messages[0])).toEqual(["tool_use"]);
    expect(out.messages[0]?.content[0]).toMatchObject({ id: "c1" });
    expect(out.pruned).toMatchObject([{ toolUseId: "c2" }]);
  });

  it("positions a verdict at its index in the messages it was given", () => {
    const out = repairToolSpans([
      msg("user", [text("go")]),
      msg("assistant", [text("a"), text("b"), call("c9")]),
    ]);
    expect(out.pruned[0]).toMatchObject({ messageIndex: 1, partIndex: 2 });
  });

  it("leaves an already-empty message alone — it did not create it", () => {
    const messages = [msg("assistant", [])];
    expect(repairToolSpans(messages).messages).toBe(messages);
  });

  it("repairs a cut that lands between a call and its result", () => {
    // What token-budget eviction produces: the head of the conversation is gone,
    // and the surviving tool message answers a call nobody can see.
    const full = [
      msg("user", [text("q")]),
      msg("assistant", [call("c1")]),
      msg("tool", [result("c1")]),
      msg("assistant", [text("answer")]),
    ];
    const evicted = full.slice(2);
    const out = repairToolSpans(evicted);
    expect(roles(out.messages)).toEqual(["assistant"]);
    expect(types(out.messages[0])).toEqual(["text"]);
  });
});
