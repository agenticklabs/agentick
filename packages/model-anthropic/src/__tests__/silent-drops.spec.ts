/**
 * What this adapter currently DISCARDS, pinned.
 *
 * A characterization test in Feathers' sense: it asserts today's behaviour including the
 * parts that are wrong, so a fix cannot land silently. Every entry here was a prose `TODO`
 * before `detectDroppedInputs` existed — which is the point. A comment saying "dropped for
 * now" is invisible at runtime and ages into a lie; a failing test is not.
 *
 * The invariant behind it: **no canonical input may be discarded or transformed silently.**
 * Each line below is a live violation, and the fix for each is either to carry the input or
 * to declare that it cannot be carried. Update this file when one is fixed — deliberately.
 */

import { describe, expect, it } from "vitest";
import type { LanguageModelInput, LanguageModelMessagePart } from "@agentick/spec";

import { detectDroppedInputs } from "@agentick/model";

import { anthropic } from "../anthropic-adapter.js";

const part = (type: string, extra: object = {}): LanguageModelMessagePart =>
  ({ type, ...extra }) as LanguageModelMessagePart;

const b64 = { type: "base64", data: "AAAA" } as const;

describe("anthropic() — inputs currently discarded", () => {
  const audit = (input: LanguageModelInput) => detectDroppedInputs(anthropic(), input);

  it("drops AUDIO and VIDEO parts — the projection has no arm for either", () => {
    // Not a `null` return anywhere: those cases fall off the end of the `switch`. This is
    // exactly the class no decline-reporting convention could have covered, and why
    // `capabilities.media` omits both modalities.
    const result = audit({
      messages: [
        {
          role: "user",
          content: [
            part("text", { text: "hi" }),
            part("audio", { source: b64 }),
            part("video", { source: b64 }),
          ],
        },
      ],
    });
    expect(result.parts.map((p) => p.partType)).toEqual(["audio", "video"]);
  });

  it("drops responseFormat — an adopter asks for JSON and gets prose, with no error", () => {
    // Documented in @agentick/model's README as a known gap, and until now visible ONLY
    // there. `generateObject`'s validation is the safety net; nothing reported the cause.
    const result = audit({
      messages: [{ role: "user", content: [part("text", { text: "hi" })] }],
      parameters: { temperature: 0.5, responseFormat: { type: "json" } },
    });
    expect(result.parameters).toEqual(["responseFormat"]);
  });

  it("carries temperature, so the audit is discriminating rather than pessimistic", () => {
    const result = audit({
      messages: [{ role: "user", content: [part("text", { text: "hi" })] }],
      parameters: { temperature: 0.5, topP: 0.9 },
    });
    expect(result.parameters).toEqual([]);
  });
});
