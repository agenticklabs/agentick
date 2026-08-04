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

import { google } from "../google-adapter.js";

const part = (type: string, extra: object = {}): LanguageModelMessagePart =>
  ({ type, ...extra }) as LanguageModelMessagePart;

describe("google() — inputs currently discarded", () => {
  const audit = (input: LanguageModelInput) =>
    detectDroppedInputs(google("gemini-2.0-flash"), input);

  it("drops a replayed REASONING part — TODO(adr-57-followup)", () => {
    // Gemini round-trips reasoning via `thoughtSignature` on the functionCall part, not as
    // a replayed reasoning content part, so a bare one is dropped rather than flattened
    // into a text bomb. The choice is right; the silence is what this pins.
    const result = audit({
      messages: [
        {
          role: "user",
          content: [
            part("text", { text: "hi" }),
            part("reasoning", {
              text: "prior thought",
              providerOptions: { anthropic: { signature: "sig" } },
            }),
          ],
        },
      ],
    });
    expect(result.parts.map((p) => p.partType)).toEqual(["reasoning"]);
  });

  it("carries all four media modalities from a base64 source", () => {
    // The other side of the ledger: google's ONE `googlePartFromSource` path means every
    // modality is carried, which is why its declaration lists all four.
    const result = audit({
      messages: [
        {
          role: "user",
          content: [
            part("image", { source: { type: "base64", data: "AAAA" } }),
            part("document", { source: { type: "base64", data: "AAAA" } }),
            part("audio", { source: { type: "base64", data: "AAAA" } }),
            part("video", { source: { type: "base64", data: "AAAA" } }),
          ],
        },
      ],
    });
    expect(result.parts).toEqual([]);
  });
});
