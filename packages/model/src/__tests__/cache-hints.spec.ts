/**
 * CacheHint wake-up (#185): entry-level hints reach the executor
 * boundary via canonical projection. Normalize → translate → escape
 * hatch: the anthropic translation is pinned in model-anthropic's spec.
 */

import { describe, expect, it } from "vitest";

import type { RenderedTree } from "@agentick/spec";

import { buildMessages } from "../canonical-projection.js";

function tree(entries: RenderedTree["context"]["entries"]): RenderedTree {
  return { specVersion: "2026-05-08", context: { entries } };
}

describe("buildMessages — CacheHint carry (#185)", () => {
  it("carries MessageEntry.metadata.cache onto the canonical message", () => {
    const messages = buildMessages(
      tree([
        {
          kind: "message",
          id: "m1",
          role: "user",
          content: [{ type: "text", text: "hi" }],
          metadata: { cache: { ttl: "5m" } },
        },
      ]),
    );
    expect(messages[0]).toMatchObject({ role: "user", cache: { ttl: "5m" } });
  });

  it("carries a BLOCK-level hint onto the part it rides (ADR 94)", () => {
    // The per-section boundary after sections became content: the compiler
    // stamps the hint on the block a `<Section cache={...}>` produced, and
    // one block is one part, so the breakpoint survives with no special
    // system-message handling anywhere.
    const messages = buildMessages(
      tree([
        {
          kind: "message",
          role: "system",
          content: [
            { type: "text", text: "STABLE PREFIX", cache: { ttl: "1h" } },
            { type: "text", text: "volatile" },
          ],
        },
      ]),
    );
    const system = messages[0]!;
    expect(system.role).toBe("system");
    expect(system.content).toHaveLength(2);
    expect(system.content[0]).toMatchObject({ text: "STABLE PREFIX", cache: { ttl: "1h" } });
    expect(system.content[1]).not.toHaveProperty("cache");
  });

  it("marks the LAST part when the hint is on the system MESSAGE", () => {
    // The image is what keeps this message at three parts: adjacent TEXT parts
    // join, and a media part breaks the run. Two bare text blocks would now be
    // ONE part and the "last, not the first" claim would have nowhere to fail.
    const messages = buildMessages(
      tree([
        {
          kind: "message",
          role: "system",
          content: [
            { type: "text", text: "A" },
            { type: "image", source: { type: "url", url: "https://example.test/1.png" } },
            { type: "text", text: "B" },
          ],
          metadata: { cache: { ttl: "5m" } },
        },
      ]),
    );
    expect(messages[0]!.content).toHaveLength(3);
    expect(messages[0]!.content[0]).not.toHaveProperty("cache");
    expect(messages[0]!.content[2]).toMatchObject({ text: "B", cache: { ttl: "5m" } });
  });
});

describe("buildMessages — adjacent text parts join at the wire", () => {
  // The join moved here from the formatter pass, where it applied only to the
  // two blocks that happened to be adjacent SECTIONS. Nothing about the defect
  // was ever section-specific: a provider may concatenate a message's text
  // parts with no separator, so any two adjacent text parts run together.

  it("joins two sections into the exact bytes the formatter merge produced", () => {
    // THE CONSERVATION PIN for vertical A. `# A\nfirst\n\n# B\nsecond` is what
    // two sections in one message have produced since before ADR 94, when they
    // were hoisted into one system blob. Removing the merge must not move a
    // single byte of it.
    const messages = buildMessages(
      tree([
        {
          kind: "message",
          role: "system",
          content: [
            { type: "text", text: "# A\nfirst", id: "a", metadata: { section: "a" } },
            { type: "text", text: "# B\nsecond", id: "b", metadata: { section: "b" } },
          ],
        },
      ]),
    );
    expect(messages[0]!.content).toEqual([{ type: "text", text: "# A\nfirst\n\n# B\nsecond" }]);
  });

  it("refuses to join across a cache hint — the breakpoint IS the boundary", () => {
    // #185, restated one level down. A hinted part marks a position in the
    // prompt text; joining it into its neighbour would move the breakpoint.
    const messages = buildMessages(
      tree([
        {
          kind: "message",
          role: "system",
          content: [
            { type: "text", text: "# A\nfirst", cache: { ttl: "1h" } },
            { type: "text", text: "# B\nsecond" },
          ],
        },
      ]),
    );
    expect(messages[0]!.content).toHaveLength(2);
    expect(messages[0]!.content[0]).toMatchObject({ text: "# A\nfirst", cache: { ttl: "1h" } });
    expect(messages[0]!.content[1]).toMatchObject({ text: "# B\nsecond" });
  });

  it("refuses to join across per-part provider knobs, in either direction", () => {
    // A `providerMetadata` bag projects to the part's `providerOptions`.
    // Joining would silently widen one part's knobs over its neighbour's text.
    const messages = buildMessages(
      tree([
        {
          kind: "message",
          role: "user",
          content: [
            { type: "text", text: "plain" },
            { type: "text", text: "knobbed", providerMetadata: { anthropic: { x: 1 } } },
            { type: "text", text: "plain again" },
          ],
        },
      ]),
    );
    expect(messages[0]!.content.map((p) => (p.type === "text" ? p.text : p.type))).toEqual([
      "plain",
      "knobbed",
      "plain again",
    ]);
  });

  it("joins across nothing else — a media part breaks the run", () => {
    const messages = buildMessages(
      tree([
        {
          kind: "message",
          role: "user",
          content: [
            { type: "text", text: "one" },
            { type: "text", text: "two" },
            { type: "image", source: { type: "url", url: "https://example.test/1.png" } },
            { type: "text", text: "three" },
          ],
        },
      ]),
    );
    expect(messages[0]!.content.map((p) => (p.type === "text" ? p.text : p.type))).toEqual([
      "one\n\ntwo",
      "image",
      "three",
    ]);
  });

  it("leaves a message with nothing to join exactly as it was", () => {
    const entry = {
      kind: "message" as const,
      role: "user",
      content: [{ type: "text" as const, text: "hi" }],
    };
    expect(buildMessages(tree([entry]))[0]!.content).toEqual([{ type: "text", text: "hi" }]);
  });
});
