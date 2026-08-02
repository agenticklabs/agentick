import { describe, expect, it } from "vitest";

import { customBlockTransform, thinkTagTransform } from "../tag-transforms.js";
import type { AdapterDelta } from "@agentick/spec";

/**
 * Text outside a tag must be re-emitted on the block it ARRIVED on.
 *
 * `handleTagEvent` used to hardcode `blockIndex: 0`, on the reasoning that 0 is
 * "the canonical assistant text block". That is only true when a response has
 * exactly one text block. It is false whenever:
 *
 *   - a reasoning block precedes the text (block 0 is reasoning, text is 1)
 *   - a function call splits the response, so the adapter opens a second text
 *     block after it
 *
 * In both cases the adapter assigns distinct indices and the transform
 * collapsed them onto 0, so `StreamAccumulator` concatenated content the
 * adapter had correctly separated.
 *
 * It shipped for months because the symptom looks like a MODEL problem: the
 * assistant's reply begins with the tail of its own thought text, joined with
 * no separator — `", agent-admin."` immediately followed by the real answer —
 * while the block actually opened for that answer finishes empty. Nothing
 * errors. Every test that used a single text block passed.
 *
 * The transform is only installed when an adopter declares custom blocks, which
 * is why it took a production app with `{ done: {} }` to surface it.
 */

const textDelta = (blockIndex: number, delta: string): AdapterDelta => ({
  type: "content-delta",
  blockIndex,
  delta,
});

const blockIndicesOf = (out: readonly AdapterDelta[]): number[] =>
  out
    .filter((d) => d.type === "content-delta")
    .map((d) => (d as { blockIndex: number }).blockIndex);

describe("tag transforms preserve the source block index", () => {
  describe("customBlockTransform", () => {
    const transform = () => customBlockTransform({ done: {} });

    it("re-emits untagged text on the block it arrived on", () => {
      const out = transform().process(textDelta(1, "Here are your todos:"));
      expect(blockIndicesOf(out)).toEqual([1]);
    });

    // The regression. Block 0 is reasoning; the answer is block 1. Rewriting to
    // 0 put the answer into the reasoning block's slot, where the accumulator
    // then lost one to the other.
    it("does NOT rewrite block 1 to block 0 when a reasoning block precedes it", () => {
      const out = transform().process(textDelta(1, "the answer"));
      expect(blockIndicesOf(out)).not.toContain(0);
    });

    it("keeps two text blocks separate rather than concatenating them", () => {
      const t = transform();
      const first = t.process(textDelta(0, "thought tail, agent-admin."));
      const second = t.process(textDelta(2, "Here are your 10 most recent todos:"));
      expect(blockIndicesOf(first)).toEqual([0]);
      expect(blockIndicesOf(second)).toEqual([2]);
    });

    it("passes non-text deltas through untouched", () => {
      const start: AdapterDelta = { type: "content-start", blockIndex: 3, blockType: "text" };
      expect(transform().process(start)).toEqual([start]);
    });

    it("strips the declared tag and keeps the surrounding text on its block", () => {
      const out = transform().process(textDelta(2, "all done<done/>"));
      const texts = out
        .filter((d) => d.type === "content-delta")
        .map((d) => (d as { delta: string }).delta);
      expect(texts.join("")).toBe("all done");
      expect(blockIndicesOf(out)).toEqual([2]);
    });

    // `flush` has no delta in hand, so the tail has to inherit the last block
    // seen — not 0, which would reintroduce the bug at end-of-stream.
    it("flushes a trailing partial tag onto the last block seen, not block 0", () => {
      const t = transform();
      t.process(textDelta(4, "trailing text <do"));
      const out = t.flush();
      expect(blockIndicesOf(out).every((i) => i === 4)).toBe(true);
    });
  });

  describe("thinkTagTransform", () => {
    it("re-emits untagged text on the block it arrived on", () => {
      const out = thinkTagTransform().process(textDelta(2, "plain answer"));
      expect(blockIndicesOf(out)).toEqual([2]);
    });

    // Routed reasoning keeps its own sentinel index — that one IS fixed by
    // design, so it sorts before the assistant text block.
    it("still routes <think> content to the reasoning sentinel", () => {
      const out = thinkTagTransform().process(textDelta(1, "<think>pondering</think>after"));
      const kinds = out.map((d) => d.type);
      expect(kinds).toContain("reasoning-start");
      expect(blockIndicesOf(out)).toEqual([1]);
    });
  });
});
