import { describe, expect, it } from "vitest";
import type { AdapterDelta, ContentBlock, Source } from "@agentick/spec";
import { defaultFinalizeStream } from "../language-model-adapter.js";
import type { StreamAccumulatorView } from "../language-model-adapter.js";

/**
 * The message-level roll-up: `defaultFinalizeStream` aggregates every block's
 * `sources` (deduped by turn-stable {@link Source.id}) onto the synthesized
 * assistant `message.sources`. A source cited from TWO blocks appears ONCE on
 * the message aggregate, under the same id — the "Sources" footer surface.
 *
 * Adapters attach block-level `sources` only (see the four model-* adapters);
 * this is the `@agentick/model-owned` roll-up they defer to. Typed against
 * {@link StreamAccumulatorView} so a spec change breaks this stub at compile time.
 */
function stubView(blocks: ContentBlock[]): StreamAccumulatorView {
  return {
    textByBlock: new Map(),
    reasoningByBlock: new Map(),
    toolCalls: new Map(),
    openBlocks: new Map(),
    messageStarted: true,
    messageEnded: true,
    modelSeen: "test-model",
    highWaterBlockIndex: blocks.length - 1,
    stopReason: "end",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    providerExtra: undefined,
    totalText: () => "",
    totalReasoning: () => "",
    toolCallInput: () => ({}),
    toContentBlocks: () => blocks,
  };
}

describe("message sources roll-up (defaultFinalizeStream)", () => {
  it("dedupes a source cited in two blocks into one message source (same id)", () => {
    const s0: Source = { id: "s0", url: "https://example.com/optics", title: "Optics 101" };
    // Same Source entity (same id) referenced from two distinct text blocks.
    const blocks: ContentBlock[] = [
      { type: "text", text: "First claim.", citations: [{ sourceId: "s0" }], sources: [s0] },
      { type: "text", text: "Second claim.", citations: [{ sourceId: "s0" }], sources: [s0] },
    ];

    const deltas = defaultFinalizeStream(stubView(blocks));
    const summary = deltas.find(
      (d): d is Extract<AdapterDelta, { type: "message" }> => d.type === "message",
    );
    expect(summary).toBeDefined();

    // One message-level source (deduped union across the two blocks), same id.
    expect(summary?.message.sources).toEqual([s0]);
    // Block-level `sources` are preserved for self-contained resolution.
    const messageBlocks = summary?.message.content ?? [];
    expect(messageBlocks.every((b) => b.sources?.[0]?.id === "s0")).toBe(true);
  });

  it("unions distinct sources across blocks, deduping only shared ids", () => {
    const s0: Source = { id: "s0", url: "https://example.com/a" };
    const s1: Source = { id: "s1", url: "https://example.com/b" };
    const blocks: ContentBlock[] = [
      {
        type: "text",
        text: "Cites A and B.",
        citations: [{ sourceId: "s0" }, { sourceId: "s1" }],
        sources: [s0, s1],
      },
      { type: "text", text: "Cites A again.", citations: [{ sourceId: "s0" }], sources: [s0] },
    ];

    const deltas = defaultFinalizeStream(stubView(blocks));
    const summary = deltas.find(
      (d): d is Extract<AdapterDelta, { type: "message" }> => d.type === "message",
    );
    expect(summary?.message.sources).toEqual([s0, s1]);
  });
});
