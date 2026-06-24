/**
 * Canonical projection — `messagePartFromBlock` and friends drive how
 * a {@link ContentBlock} surfaces on the model-facing
 * {@link LanguageModelMessagePart} boundary. Provider adapters then
 * project this further, so the projections defined here are the
 * framework's load-bearing wire contracts.
 */

import { describe, expect, it } from "vitest";

import type { ContentBlock, TaskRefBlock } from "@agentick/spec-next";

import { messagePartFromBlock } from "../canonical-projection.js";

describe("messagePartFromBlock — task_ref drop-in projection (#160)", () => {
  it("projects a task_ref block to a text part carrying the legacy `_kind: 'session_task_ref'` JSON shape", async () => {
    // Adopters that already parse the JSON-in-text envelope MUST keep
    // working with no changes. The first-class block-type discriminator
    // lives ABOVE this boundary; once we cross into
    // `LanguageModelMessagePart` territory (model wire), the projection
    // collapses to text-JSON so every provider adapter handles it
    // uniformly.
    const block: TaskRefBlock = {
      type: "task_ref",
      taskId: "task:abc",
      status: "working",
      statusMessage: "deploying",
      ttl: 60_000,
      pollInterval: 1_000,
    };
    const part = messagePartFromBlock(block);
    expect(part.type).toBe("text");
    if (part.type !== "text") return; // narrow for TS
    const parsed = JSON.parse(part.text) as {
      _kind: string;
      taskId: string;
      status: string;
      statusMessage?: string;
      ttl?: number;
      pollInterval?: number;
    };
    expect(parsed).toEqual({
      _kind: "session_task_ref",
      taskId: "task:abc",
      status: "working",
      statusMessage: "deploying",
      ttl: 60_000,
      pollInterval: 1_000,
    });
  });

  it("omits optional fields from the projected JSON when the block doesn't carry them", async () => {
    const block: TaskRefBlock = {
      type: "task_ref",
      taskId: "task:min",
      status: "pending",
    };
    const part = messagePartFromBlock(block);
    expect(part.type).toBe("text");
    if (part.type !== "text") return;
    const parsed = JSON.parse(part.text) as Record<string, unknown>;
    expect(parsed).toEqual({
      _kind: "session_task_ref",
      taskId: "task:min",
      status: "pending",
    });
    expect(Object.keys(parsed)).not.toContain("statusMessage");
    expect(Object.keys(parsed)).not.toContain("ttl");
    expect(Object.keys(parsed)).not.toContain("pollInterval");
  });

  it("forwards providerMetadata onto the projected text part", async () => {
    // Round-trip data stamped on the structured block (e.g. an MCP
    // adapter tagging the task for a specific cache namespace) must
    // survive projection — otherwise the provider step loses the
    // metadata and we re-introduce the bug that providerMetadata
    // exists to prevent.
    const block: ContentBlock = {
      type: "task_ref",
      taskId: "task:meta",
      status: "working",
      providerMetadata: { anthropic: { cacheControl: { type: "ephemeral" } } },
    };
    const part = messagePartFromBlock(block);
    expect(part.providerMetadata).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });
});
