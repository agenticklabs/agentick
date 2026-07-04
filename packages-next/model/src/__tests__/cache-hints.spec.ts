/**
 * CacheHint wake-up (#185): entry-level hints reach the executor
 * boundary via canonical projection. Normalize → translate → escape
 * hatch: the anthropic translation is pinned in model-anthropic's spec.
 */

import { describe, expect, it } from "vitest";

import type { RenderedTree } from "@agentick/spec-next";

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

  it("unhinted sections keep the single joined system blob", () => {
    const messages = buildMessages(
      tree([
        { kind: "section", id: "s1", content: [{ type: "text", text: "A" }] },
        { kind: "section", id: "s2", content: [{ type: "text", text: "B" }] },
      ]),
    );
    expect(messages[0]!.content).toHaveLength(1);
    expect(messages[0]!.content[0]).toMatchObject({ type: "text", text: "A\n\nB" });
  });

  it("a cache-hinted section switches system to per-section parts with the hint on the part", () => {
    const messages = buildMessages(
      tree([
        {
          kind: "section",
          id: "s1",
          content: [{ type: "text", text: "STABLE PREFIX" }],
          metadata: { cache: { ttl: "1h" } },
        },
        { kind: "section", id: "s2", content: [{ type: "text", text: "volatile" }] },
      ]),
    );
    const system = messages[0]!;
    expect(system.role).toBe("system");
    expect(system.content).toHaveLength(2);
    expect(system.content[0]).toMatchObject({ text: "STABLE PREFIX", cache: { ttl: "1h" } });
    expect(system.content[1]).not.toHaveProperty("cache");
  });
});
