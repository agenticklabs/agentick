/**
 * Bind an adapter's `capabilities.media` declaration to what it actually puts on the
 * wire — with no provider-specific code, because the two mechanisms police each other.
 *
 * The declaration is what the framework ENFORCES: `applyMediaSupport` drops anything a
 * target says it cannot carry, immediately before `prepareRequest`. That only helps while
 * the declaration stays true, and nothing about a literal in a `capabilities` bag keeps it
 * true — an adapter can gain a source arm, lose one, or ship a typo, after which a stale
 * declaration silently drops media that works or forwards media that does not.
 *
 * ## Why this needs no `carries` predicate
 *
 * The first version of this took a per-adapter predicate answering "does this native
 * request carry a part of this modality" — three hand-written functions poking at Gemini
 * `inlineData`, OpenAI `image_url` and Anthropic block shapes. All three are gone, because
 * {@link import("../dropped-inputs.js").detectDroppedInputs} answers the same question
 * generically: a part that contributes nothing to the native request was dropped.
 *
 * That reduces the whole check to two implications, in one coordinate system:
 *
 *   - **declared carried** ⇒ the part must NOT be dropped
 *   - **declared not carried** ⇒ the part MUST be dropped
 *
 * And the second implication is stronger than it looks: it is what would have caught the
 * original bug. A `reference` image emitted as `fileUri: "<uuid>"` is not dropped — the
 * request changed — so declaring it unsupported while the adapter forwards it invalidly
 * fails here. Drop-detection alone is blind to that case; the declaration alone cannot be
 * verified. Together they cover both.
 *
 * `prepareRequest` is driven DIRECTLY, deliberately bypassing `applyMediaSupport`.
 * Screening first would make this tautological — the screen would remove everything
 * undeclared and the adapter would only ever be asked about what it declared. Feeding an
 * adapter what it says it cannot carry is the only way to learn whether the claim is
 * honest.
 */

import { describe, expect, it } from "vitest";

import type { LanguageModelInput, LanguageModelMessagePart, MediaSource } from "@agentick/spec";

import { detectDroppedInputs, type ProjectingAdapter } from "../dropped-inputs.js";

/** The four modalities a declaration covers. */
export const MEDIA_MODALITIES = ["image", "document", "audio", "video"] as const;

export type MediaModality = (typeof MEDIA_MODALITIES)[number];

const ALL_KINDS: readonly MediaSource["type"][] = ["base64", "url", "reference"];

const sourceOfKind = (kind: MediaSource["type"]): MediaSource => {
  switch (kind) {
    case "base64":
      return { type: "base64", data: "AAAA", mimeType: "application/octet-stream" };
    case "url":
      return { type: "url", url: "https://example.com/asset.bin" };
    case "reference":
      return { type: "reference", fileId: "019faa2c-5506-7000-b8ea-3c63628e4c89" };
  }
};

/**
 * Assert every modality x every source kind reaches the wire **iff** the adapter's own
 * declaration says it does.
 *
 * Requires a declaration — an adapter that deliberately declares nothing (a meta-adapter
 * that cannot know its provider's limits) has no claim to check and asserts its own
 * silence locally instead.
 */
export function runMediaDeclarationCheck(adapter: ProjectingAdapter): void {
  const declared = adapter.target.capabilities?.media;
  if (declared === undefined) {
    throw new Error(
      `runMediaDeclarationCheck: ${adapter.provider} declares no capabilities.media, so ` +
        `there is nothing to check against. An adapter that deliberately declares nothing ` +
        `should assert that directly instead of running this suite.`,
    );
  }

  describe(`${adapter.provider}() — capabilities.media matches the wire projection`, () => {
    for (const modality of MEDIA_MODALITIES) {
      it(`carries exactly the declared ${modality} source kinds`, () => {
        const allowed = declared[modality] ?? [];

        // Compared as whole maps so a failure prints the declaration the adapter's
        // behaviour actually implies beside the one it published — the diff worth reading,
        // rather than a bare boolean on the first divergence.
        const actual: Record<string, boolean> = {};
        const expected: Record<string, boolean> = {};
        for (const kind of ALL_KINDS) {
          const input: LanguageModelInput = {
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "Describe this." },
                  { type: modality, source: sourceOfKind(kind) } as LanguageModelMessagePart,
                ],
              },
            ],
          };
          const dropped = detectDroppedInputs(adapter, input).parts;
          actual[kind] = !dropped.some((p) => p.partType === modality);
          expected[kind] = allowed.includes(kind);
        }
        expect(actual).toEqual(expected);
      });
    }
  });
}
