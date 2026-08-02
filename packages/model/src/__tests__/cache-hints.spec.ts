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
    const messages = buildMessages(
      tree([
        {
          kind: "message",
          role: "system",
          content: [
            { type: "text", text: "A" },
            { type: "text", text: "B" },
          ],
          metadata: { cache: { ttl: "5m" } },
        },
      ]),
    );
    expect(messages[0]!.content[0]).not.toHaveProperty("cache");
    expect(messages[0]!.content[1]).toMatchObject({ text: "B", cache: { ttl: "5m" } });
  });
});
