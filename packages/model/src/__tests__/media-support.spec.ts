/**
 * The screen, and the two properties that make it worth having: an adapter cannot
 * opt out of it, and its verdicts join provenance to name a durable timeline id.
 *
 * The failure it exists to prevent is not a rejected request — it is a request
 * that SUCCEEDS with the user's attachment missing and nobody told. So the tests
 * below care most about what happens to the parts NEXT to a declined one, and
 * about the modality an adapter has no code for at all.
 */

import { describe, expect, it } from "vitest";
import type {
  ContentBlock,
  ExecutionTarget,
  LanguageModelMessage,
  MessageEntry,
  RenderedTree,
} from "@agentick/spec";
import { SPEC_VERSION } from "@agentick/spec";

import { buildMessages } from "../canonical-projection.js";
import { applyMediaSupport } from "../media-support.js";
import { buildMessageProvenance } from "../provenance.js";

const text = (t: string): ContentBlock => ({ type: "text", text: t }) as ContentBlock;
const imageRef = (fileId: string): ContentBlock =>
  ({ type: "image", source: { type: "reference", fileId } }) as ContentBlock;
const imageUrl = (url: string): ContentBlock =>
  ({ type: "image", source: { type: "url", url } }) as ContentBlock;
const audioB64 = (data: string): ContentBlock =>
  ({ type: "audio", source: { type: "base64", data, mimeType: "audio/wav" } }) as ContentBlock;

const msg = (role: string, content: readonly ContentBlock[]): LanguageModelMessage =>
  ({ role, content }) as unknown as LanguageModelMessage;

const target = (media?: ExecutionTarget["capabilities"]): ExecutionTarget =>
  ({
    kind: "language-model",
    provider: "acme",
    ...(media !== undefined ? { capabilities: media } : {}),
  }) as ExecutionTarget;

/** What Anthropic declares: images/documents from two kinds, no audio, no video. */
const ANTHROPIC_LIKE = target({
  media: { image: ["base64", "url"], document: ["base64", "url"] },
});

describe("an undeclared target is not screened", () => {
  it("passes everything through untouched when `media` is absent", () => {
    // Absence means UNDECLARED, never "carries nothing". If it read as the empty
    // set, every target that has not opted in would silently start dropping media
    // — including the AI SDK adapter, which deliberately declares nothing.
    const messages = [msg("user", [text("hi"), imageRef("f-1")])];
    const result = applyMediaSupport(messages, target({ supportsVision: true }));
    expect(result.declined).toEqual([]);
    expect(result.messages).toBe(messages);
  });

  it("is not screened when the target has no capabilities at all", () => {
    const messages = [msg("user", [imageRef("f-1")])];
    expect(applyMediaSupport(messages, target()).declined).toEqual([]);
  });
});

describe("a declared target is screened", () => {
  it("declines a source kind the modality does not list", () => {
    const result = applyMediaSupport([msg("user", [imageRef("019faa2c")])], ANTHROPIC_LIKE);
    expect(result.declined).toEqual([
      {
        messageIndex: 0,
        partIndex: 0,
        partType: "image",
        sourceType: "reference",
        reason: "acme cannot carry a image from a 'reference' source (carries: base64, url)",
      },
    ]);
  });

  it("carries a source kind the modality does list", () => {
    const messages = [msg("user", [imageUrl("https://example.com/c.png")])];
    const result = applyMediaSupport(messages, ANTHROPIC_LIKE);
    expect(result.declined).toEqual([]);
    expect(result.messages[0]!.content).toHaveLength(1);
  });

  it("declines an ENTIRE MODALITY the declaration omits", () => {
    // The case no amount of adapter discipline could have caught: Anthropic's
    // projection has no `audio` arm, so an audio part falls off the end of its
    // switch and vanishes with no `null` returned anywhere to report. Omitting
    // the modality from the declaration turns that hole into a stated fact.
    const result = applyMediaSupport([msg("user", [audioB64("UklGR...")])], ANTHROPIC_LIKE);
    expect(result.declined[0]).toMatchObject({
      partType: "audio",
      sourceType: "base64",
      reason: "acme carries no audio parts",
    });
  });

  it("reads an explicit empty list the same as an omitted modality", () => {
    const result = applyMediaSupport(
      [msg("user", [audioB64("x")])],
      target({ media: { image: ["url"], audio: [] } }),
    );
    expect(result.declined[0]?.reason).toBe("acme carries no audio parts");
  });
});

describe("what happens to the parts NEXT to a declined one", () => {
  it("a declined image does NOT take the user's text with it", () => {
    // The regression that matters. Dropping the whole message on an unprojectable
    // block turns one bad attachment into a silently truncated conversation.
    const result = applyMediaSupport(
      [msg("user", [text("what is that?"), imageRef("f-1"), text("thanks")])],
      ANTHROPIC_LIKE,
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.content.map((p) => p.type)).toEqual(["text", "text"]);
  });

  it("drops a message left with NO parts, rather than sending empty content", () => {
    // Most providers reject a message with an empty `content` array outright — so
    // declining the only part means declining the message.
    const result = applyMediaSupport(
      [msg("user", [text("look:")]), msg("user", [imageRef("f-1")]), msg("assistant", [text("k")])],
      ANTHROPIC_LIKE,
    );
    expect(result.messages).toHaveLength(2);
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("leaves an already-empty message alone — emptiness it did not cause is not its business", () => {
    const result = applyMediaSupport([msg("user", [])], ANTHROPIC_LIKE);
    expect(result.messages).toHaveLength(1);
  });

  it("returns untouched messages BY REFERENCE when nothing was declined", () => {
    const kept = msg("user", [text("hi")]);
    const result = applyMediaSupport([kept], ANTHROPIC_LIKE);
    expect(result.messages[0]).toBe(kept);
  });
});

describe("declines join provenance — wire position to durable timeline id", () => {
  // The whole reason both halves exist. A provider names nothing; a declaration
  // names a POSITION; provenance turns that position into the timeline entry id a
  // quarantine can be recorded against. No provider knowledge, no probing, no
  // parsing an error string.
  // `m_1` is declined DOWN TO NOTHING and therefore dropped, so the filtered list
  // is shorter than the one the indices are reported against. That divergence is
  // deliberate: with a tree where every message survives, a bug that reported
  // positions in the FILTERED output would still pass every assertion here.
  const tree: RenderedTree = {
    specVersion: SPEC_VERSION,
    context: {
      entries: [
        { kind: "message", role: "user", id: "m_1", content: [imageRef("dropped-entirely")] },
        {
          kind: "message",
          role: "user",
          id: "m_7",
          content: [text("what is that?"), imageRef("019faa2c")],
        },
      ] as MessageEntry[],
    },
  } as RenderedTree;

  it("names the entry id and block index of every declined part", () => {
    const { declined } = applyMediaSupport(buildMessages(tree), ANTHROPIC_LIKE);
    const provenance = buildMessageProvenance(tree);

    expect(declined.map((d) => provenance[d.messageIndex]?.[d.partIndex])).toEqual([
      { entryId: "m_1", blockIndex: 0 },
      { entryId: "m_7", blockIndex: 1 },
    ]);
  });

  it("indexes the UNFILTERED projection, which is the coordinate system provenance uses", () => {
    // Both halves must agree on what index 1 means. `applyMediaSupport` reports
    // positions in the messages handed TO it — the output of `buildMessages` — not
    // in the filtered list it returns. Reporting the filtered position would name
    // `m_1` for a block that came from `m_7`: an attribution that is not merely
    // imprecise but points at the wrong entry, which is worse than none.
    const messages = buildMessages(tree);
    const { declined, messages: wire } = applyMediaSupport(messages, ANTHROPIC_LIKE);
    expect(wire).toHaveLength(1); // m_1 is gone — the two lists no longer line up
    for (const d of declined) {
      expect(messages[d.messageIndex]!.content[d.partIndex]!.type).toBe("image");
    }
  });
});

describe("urlSchemes — the precision that let `s3` and `gcs` be deleted", () => {
  // Those variants existed to be re-concatenated into a URI, so the only fact they
  // really encoded was WHICH SCHEME a provider can fetch. Stating that directly covers
  // every scheme rather than the two that happened to get variants — and keeps the hole
  // they were closing shut, since a `gs://` URL to a provider that cannot read it would
  // otherwise be the original poisoning bug with a different spelling.
  const VERTEX_LIKE = target({ media: { image: ["url"], urlSchemes: ["https", "gs"] } });
  const HTTP_ONLY = target({ media: { image: ["url"] } });

  it("carries a declared scheme", () => {
    const result = applyMediaSupport([msg("user", [imageUrl("gs://b/o.png")])], VERTEX_LIKE);
    expect(result.declined).toEqual([]);
  });

  it("declines an undeclared scheme, naming it", () => {
    const result = applyMediaSupport([msg("user", [imageUrl("gs://b/o.png")])], HTTP_ONLY);
    expect(result.declined[0]).toMatchObject({ partType: "image", sourceType: "url" });
    expect(result.declined[0]!.reason).toBe(
      "acme cannot fetch a 'gs:' URI (fetches: http, https, data)",
    );
  });

  it("defaults to http / https / data when urlSchemes is absent", () => {
    for (const url of ["https://x/y.png", "http://x/y.png", "data:image/png;base64,AAAA"]) {
      expect(applyMediaSupport([msg("user", [imageUrl(url)])], HTTP_ONLY).declined).toEqual([]);
    }
  });

  it("is case-insensitive about the scheme", () => {
    expect(applyMediaSupport([msg("user", [imageUrl("HTTPS://x/y")])], HTTP_ONLY).declined).toEqual(
      [],
    );
  });

  it("declines a bare or relative string, which names no scheme at all", () => {
    // `/media/x.png` or `x.png` is not a URI any provider can fetch, and reading it as
    // "no scheme, therefore fine" is how a relative path reaches a provider verbatim.
    const result = applyMediaSupport([msg("user", [imageUrl("/media/x.png")])], HTTP_ONLY);
    expect(result.declined).toHaveLength(1);
  });

  it("does not scheme-check a base64 source", () => {
    const b64 = { type: "base64", data: "AAAA" } as const;
    const result = applyMediaSupport(
      [msg("user", [{ type: "image", source: b64 } as ContentBlock])],
      target({ media: { image: ["base64"], urlSchemes: ["gs"] } }),
    );
    expect(result.declined).toEqual([]);
  });
});
