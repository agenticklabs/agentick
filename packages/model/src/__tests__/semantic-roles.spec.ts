/**
 * The role seam (ADR 94).
 *
 * `MessageEntry.role` is an OPEN string — an application can tag its own
 * turns — and a provider request has a CLOSED set of slots. The two used to
 * meet at `entry.role as LanguageModelMessage["role"]`, an unchecked cast
 * that let `role: "event"` reach providers with no such role and let a typo
 * arrive as a 400 with no local explanation.
 *
 * What replaces it is two steps in two places: the canonical fold NARROWS
 * (and keeps `grounding` / `event` intact, because they mean something to
 * the framework), and each adapter LOWERS to its own vocabulary at its own
 * boundary. Neither step coerces.
 */

import { describe, expect, it } from "vitest";
import type { LanguageModelMessageRole, MessageEntry, RenderedTree } from "@agentick/spec";
import { SPEC_VERSION } from "@agentick/spec";

import {
  buildMessages,
  canonicalRole,
  lowerSemanticRole,
  UnknownMessageRoleError,
} from "../canonical-projection.js";

const tree = (...entries: MessageEntry[]): RenderedTree =>
  ({ specVersion: SPEC_VERSION, context: { entries } }) as RenderedTree;
const msg = (role: string, text: string): MessageEntry =>
  ({ kind: "message", role, content: [{ type: "text", text }] }) as MessageEntry;

describe("the canonical fold keeps semantic roles", () => {
  it("passes grounding and event through untouched", () => {
    const messages = buildMessages(tree(msg("grounding", "who"), msg("event", "what")));
    expect(messages.map((m) => m.role)).toEqual(["grounding", "event"]);
  });

  it("throws on a role no adapter could act on, rather than casting it", () => {
    expect(() => buildMessages(tree(msg("banana", "x")))).toThrow(UnknownMessageRoleError);
  });

  it("says what the legal roles are, so the fix does not need the source", () => {
    expect(() => canonicalRole("banana")).toThrow(/grounding/);
  });

  it("narrows every canonical role", () => {
    for (const role of ["system", "user", "assistant", "tool", "grounding", "event"] as const) {
      expect(canonicalRole(role)).toBe(role);
    }
  });
});

describe("adapters lower at their own boundary", () => {
  // The three tables the shipped adapters use, asserted as data. A role added
  // to the union breaks these at COMPILE time — `satisfies Record<...>` is
  // total over the union — which is the point of the table over a fallthrough.
  const openai = {
    system: "system",
    user: "user",
    assistant: "assistant",
    tool: "tool",
    grounding: "developer",
    event: "user",
  } as const satisfies Record<LanguageModelMessageRole, string>;

  const anthropic = {
    system: "system",
    user: "user",
    assistant: "assistant",
    tool: "tool",
    grounding: "user",
    event: "user",
  } as const satisfies Record<LanguageModelMessageRole, string>;

  it("sends grounding to OpenAI's developer channel", () => {
    // `developer` is that provider's sanctioned non-user instruction role and
    // is legal mid-stream, which is exactly what grounding needs.
    expect(lowerSemanticRole("grounding", openai)).toBe("developer");
  });

  it("sends grounding to user where the provider has no such role", () => {
    expect(lowerSemanticRole("grounding", anthropic)).toBe("user");
  });

  it("keeps event on user everywhere — an event is a record, not an instruction", () => {
    expect(lowerSemanticRole("event", openai)).toBe("user");
    expect(lowerSemanticRole("event", anthropic)).toBe("user");
  });

  it("throws rather than emitting undefined for a role missing from a table", () => {
    const partial = { user: "user" } as unknown as Record<LanguageModelMessageRole, string>;
    expect(() => lowerSemanticRole("grounding", partial)).toThrow(UnknownMessageRoleError);
  });
});

describe("system has no position, everything else keeps its own", () => {
  it("merges leading system entries, in order, into one message", () => {
    const messages = buildMessages(
      tree(msg("system", "identity"), msg("system", "rules"), msg("user", "hi")),
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content.map((p) => ("text" in p ? p.text : ""))).toEqual([
      "identity",
      "rules",
    ]);
  });

  it("leaves every other entry at its index", () => {
    const messages = buildMessages(
      tree(msg("system", "s"), msg("user", "a"), msg("grounding", "g"), msg("assistant", "b")),
    );
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "grounding", "assistant"]);
  });

  it("emits no system message at all when the tree has no system entry", () => {
    // No implicit system prompt. A tree with no `<System>` sends no system
    // instructions — the removal of section-hoisting, stated as a test.
    const messages = buildMessages(tree(msg("user", "hi")));
    expect(messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("merges a mid-stream system into the system param — the diagnostic is at COMPILE time", () => {
    // The projection keeps one path because no provider has a mid-stream
    // system position to project INTO. What stops the pattern is the
    // compiler's MID_STREAM_SYSTEM diagnostic, not a second fold here.
    const messages = buildMessages(tree(msg("user", "hi"), msg("system", "late")));
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
  });
});
