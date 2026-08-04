/**
 * Token-budget eviction and the tool-span invariant, against the real
 * `<Timeline maxTokens>` path rather than a hand-built projection.
 *
 * Neither built-in strategy produces a contiguous window: both scan newest-first
 * and keep whatever individually fits. So a fat assistant turn carrying a
 * `tool_use` was evicted while the small `tool` message right after it fit and
 * was kept — a span left half-open, and a result for a call the provider cannot
 * see, which Anthropic and Google both reject.
 *
 * This is the cross-package test: `@agentick/timeline` makes the cut,
 * `@agentick/model` is the last-resort net, and only `@agentick/session`
 * depends on both.
 */

import { describe, expect, it } from "vitest";
import type { LanguageModelMessage, TimelineEntry } from "@agentick/spec";
import { repairToolSpans } from "@agentick/model";
import { compactEntries } from "@agentick/timeline/react";

type MessageEntry = Extract<TimelineEntry, { kind: "message" }>;

const entry = (id: string, role: string, content: readonly unknown[]): MessageEntry =>
  ({ kind: "message", message: { id, role, content, ts: 0 } }) as unknown as MessageEntry;

const filler = (n: number): string => "x".repeat(n);

/** The non-system half of `buildMessages`: an entry's role and content, in place. */
const toMessages = (entries: readonly MessageEntry[]): LanguageModelMessage[] =>
  entries.map(
    (e) => ({ role: e.message.role, content: e.message.content }) as LanguageModelMessage,
  );

const ids = (entries: readonly MessageEntry[]): string[] => entries.map((e) => e.message.id);

/** A turn whose assistant half is far too fat to fit, and whose result is tiny. */
const CONVERSATION: readonly MessageEntry[] = [
  entry("u1", "user", [{ type: "text", text: filler(40) }]),
  entry("a1", "assistant", [
    { type: "text", text: filler(400) },
    { type: "tool_use", toolUseId: "c1", name: "search", input: {} },
  ]),
  entry("t1", "tool", [{ type: "tool_result", toolUseId: "c1", content: [] }]),
  entry("a2", "assistant", [{ type: "text", text: filler(40) }]),
];

describe.each(["truncate", "sliding-window"] as const)("%s eviction", (strategy) => {
  it("evicts the stranded result along with the call it answers", () => {
    const { kept, evicted } = compactEntries(CONVERSATION, { maxTokens: 60, strategy });

    // a1 does not fit. Without the pairing rule t1 does, and would be kept.
    expect(ids(evicted)).toContain("a1");
    expect(ids(kept)).not.toContain("t1");
    expect(ids(evicted)).toContain("t1");
  });

  it("leaves nothing for the wire repair to prune", () => {
    const { kept } = compactEntries(CONVERSATION, { maxTokens: 60, strategy });
    expect(repairToolSpans(toMessages(kept)).pruned).toEqual([]);
  });

  it("keeps `evicted` chronological — it reaches adopters through onEvict", () => {
    const { evicted } = compactEntries(CONVERSATION, { maxTokens: 60, strategy });
    const evictedIds = new Set(ids(evicted));
    expect(ids(evicted)).toEqual(ids(CONVERSATION).filter((id) => evictedIds.has(id)));
  });
});
