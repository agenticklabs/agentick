/**
 * What this adapter currently DISCARDS, pinned — a characterization test, so a fix cannot
 * land silently and a "dropped for now" comment cannot age into a lie.
 *
 * See the sibling file in @agentick/model-anthropic for the reasoning; the invariant is
 * **no canonical input may be discarded or transformed silently.**
 */

import { describe, expect, it } from "vitest";
import type { LanguageModelInput, LanguageModelMessagePart } from "@agentick/spec";

import { detectDroppedInputs } from "@agentick/model";

import { openai } from "../openai-adapter.js";

const part = (type: string, extra: object = {}): LanguageModelMessagePart =>
  ({ type, ...extra }) as LanguageModelMessagePart;

describe("openai() — inputs currently discarded", () => {
  const audit = (input: LanguageModelInput) => detectDroppedInputs(openai("gpt-4o"), input);

  it("drops VIDEO and replayed REASONING — both TODO(adr-57-followup)", () => {
    // Chat Completions has no video part, and does not accept replayed reasoning as input.
    // Dropping beats flattening either into text (which would feed the model its own
    // private thinking as prose) — but dropping SILENTLY is what this pins.
    const result = audit({
      messages: [
        {
          role: "user",
          content: [
            part("text", { text: "hi" }),
            part("video", { source: { type: "base64", data: "AAAA" } }),
            part("reasoning", { text: "prior thought", signature: "sig" }),
          ],
        },
      ],
    });
    expect(result.parts.map((p) => p.partType)).toEqual(["video", "reasoning"]);
  });

  it("carries responseFormat natively, unlike anthropic", () => {
    const result = audit({
      messages: [{ role: "user", content: [part("text", { text: "hi" })] }],
      parameters: { responseFormat: { type: "json" } },
    });
    expect(result.parameters).toEqual([]);
  });
});
