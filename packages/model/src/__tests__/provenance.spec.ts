/**
 * Provenance, and the invariant that makes it trustworthy.
 *
 * `buildMessageProvenance` is a SIBLING of `buildMessages`, so the happy path pays nothing
 * and no caller changes. The price is that two functions must walk the same tree the same
 * way: `provenance[i][j]` has to describe `messages[i].content[j]`. Nothing in the type
 * system enforces that, so it is enforced here — and the alignment tests deliberately use
 * awkward trees (empty sections, cache hints, id-less entries, media nested among text),
 * because that is where a divergent walk would go off by one.
 *
 * Why it matters at all: a provider rejects a REQUEST, not a block. Vertex says "the
 * fileUri parameter must be a Cloud Storage or HTTP(S) URI" and never says which of our
 * entries it came from. Parsing the error text for a clue is a heuristic that differs per
 * provider; owning the projection is a mechanism.
 */

import { describe, expect, it } from "vitest";
import type { CacheHint, ContentBlock, MessageEntry, RenderedTree } from "@agentick/spec";
import { SPEC_VERSION } from "@agentick/spec";

import { buildMessages } from "../canonical-projection.js";
import { buildMessageProvenance } from "../provenance.js";

const text = (t: string): ContentBlock => ({ type: "text", text: t }) as ContentBlock;
const imageRef = (fileId: string): ContentBlock =>
  ({ type: "image", source: { type: "reference", fileId } }) as ContentBlock;

const msg = (role: string, content: readonly ContentBlock[], id?: string): MessageEntry =>
  ({ kind: "message", role, content, ...(id !== undefined ? { id } : {}) }) as MessageEntry;

/**
 * One `<Section>` inside `<System>`, as the compiler lowers it (ADR 94): a
 * text block carrying the section's stable id, and its cache hint when it
 * has one. Sections are no longer entries, so a "section" in these trees is
 * a BLOCK — which is exactly the walk the two functions have to agree on.
 */
let sectionSeq = 0;
const sectionBlock = (title: string, body: string, cache?: CacheHint): ContentBlock =>
  ({
    type: "text",
    text: body.length > 0 ? `# ${title}\n${body}` : `# ${title}`,
    id: `sec-${++sectionSeq}`,
    ...(cache !== undefined ? { cache } : {}),
  }) as ContentBlock;

const system = (...blocks: readonly ContentBlock[]): MessageEntry => msg("system", blocks);

const tree = (...entries: MessageEntry[]): RenderedTree =>
  ({ specVersion: SPEC_VERSION, context: { entries } }) as RenderedTree;

/**
 * The invariant, as one assertion: the two walks produce the same SHAPE.
 *
 * Compared as whole arrays of lengths rather than element-by-element, so a failure prints
 * the actual vs expected shape (`[1, 2]` vs `[2, 2]`) instead of a bare number mismatch —
 * an off-by-one from a divergent walk is then obvious at a glance.
 */
const expectAligned = (t: RenderedTree): void => {
  const messages = buildMessages(t);
  const provenance = buildMessageProvenance(t);
  expect(provenance.map((row) => row.length)).toEqual(messages.map((m) => m.content.length));
};

describe("the alignment invariant — provenance[i][j] describes messages[i].content[j]", () => {
  it("holds for a plain conversation", () => {
    expectAligned(tree(msg("user", [text("hi")], "m1"), msg("assistant", [text("hello")], "m2")));
  });

  it("holds with a leading system message built from sections", () => {
    expectAligned(tree(system(sectionBlock("Rules", "be terse")), msg("user", [text("hi")], "m1")));
  });

  it("holds with CACHE-HINTED sections, which keep one part each", () => {
    expectAligned(
      tree(
        system(
          sectionBlock("A", "first", { ttl: "1h" }),
          sectionBlock("B", "second", { ttl: "1h" }),
        ),
        msg("user", [text("hi")], "m1"),
      ),
    );
  });

  it("holds when SEVERAL system entries merge into one message", () => {
    // The one place the fold still collapses entries: leading `<System>`
    // messages merge into the provider system param, so N entries become
    // ONE message and a walk that pushed a row per entry would be off by
    // N-1 for everything after it.
    expectAligned(
      tree(
        system(sectionBlock("A", "first")),
        system(sectionBlock("B", "second")),
        msg("user", [text("hi")], "m1"),
      ),
    );
  });

  it("holds when a system entry contributes NO parts", () => {
    expectAligned(tree(system(), msg("user", [text("hi")], "m1")));
  });

  it("holds when there is NO system entry at all", () => {
    expectAligned(tree(msg("user", [text("hi")], "m1")));
  });

  it("holds for a free-floating section — a grounding message at its own position", () => {
    expectAligned(
      tree(
        msg("user", [text("hi")], "m1"),
        msg("grounding", [sectionBlock("Current User", "Ryan")]),
        msg("assistant", [text("hello")], "m2"),
      ),
    );
  });

  it("holds for a message with several blocks of mixed kinds", () => {
    expectAligned(
      tree(msg("user", [text("what is that?"), imageRef("f-1"), text("thanks")], "m1")),
    );
  });

  it("holds for an EMPTY message content list", () => {
    expectAligned(tree(msg("user", [], "m1"), msg("user", [text("hi")], "m2")));
  });
});

describe("what an origin says", () => {
  const t = tree(
    system(sectionBlock("Rules", "be terse")),
    msg("user", [text("what is that?"), imageRef("019faa2c")], "m_7"),
  );

  it("names the TIMELINE MESSAGE ID, not a position", () => {
    // The whole point of recording an id. Positions shift as the conversation grows, so a
    // positional quarantine record would name the wrong block by the next turn.
    const p = buildMessageProvenance(t);
    expect(p[1]?.[1]).toEqual({ entryId: "m_7", blockIndex: 1 });
  });

  it("gives the block's index WITHIN its entry, not a flat request offset", () => {
    const p = buildMessageProvenance(t);
    expect(p[1]?.[0]).toEqual({ entryId: "m_7", blockIndex: 0 });
    expect(p[1]?.[1]?.blockIndex).toBe(1);
  });

  it("names the SECTION's stable id for a system part (ADR 94)", () => {
    // A section is no longer a top-level entry, so the id that used to be
    // unreachable from a system part now rides the block the section
    // produced — which is what makes a system part attributable at all.
    expect(buildMessageProvenance(t)[0]?.[0]).toEqual({ entryId: "sec-1", blockIndex: 0 });
  });

  it("has no entryId for a system part whose block carries no id", () => {
    // Nothing DURABLE to record — stated rather than papered over with a
    // fabricated key.
    const p = buildMessageProvenance(tree(system(text("bare"))));
    expect(p[0]![0]).toEqual({ blockIndex: 0 });
  });

  it("omits entryId for an ID-LESS entry rather than inventing one", () => {
    // A synthesized entry or a hand-built tree. Attribution still narrows to a block, but
    // nothing DURABLE can be recorded — which is a real limitation, stated rather than
    // papered over with a fabricated key.
    const p = buildMessageProvenance(tree(msg("user", [imageRef("f-1")])));
    expect(p[0]![0]).toEqual({ blockIndex: 0 });
    expect(p[0]![0]).not.toHaveProperty("entryId");
  });

  it("names the SECOND of two adjacent sections once anything makes it a part", () => {
    // RESTORED. While the formatter merged two adjacent sections into ONE
    // block, the merged block carried only the first section's id and the
    // second section's id existed nowhere downstream — it was not merely
    // unaddressable at the wire, it was unreachable, and no fixture could have
    // made this assertion pass. Two sections are two blocks now, so a
    // breakpoint (or any other boundary) between them yields two parts naming
    // two sections.
    const t = tree(
      system(sectionBlock("A", "first", { ttl: "1h" }), sectionBlock("B", "second")),
      msg("user", [text("hi")], "m1"),
    );
    expectAligned(t);
    const p = buildMessageProvenance(t);
    const [a, b] = [p[0]?.[0], p[0]?.[1]];
    expect(a?.entryId).not.toBe(b?.entryId);
    expect(a).toEqual({ entryId: a!.entryId!, blockIndex: 0 });
    expect(b).toEqual({ entryId: b!.entryId!, blockIndex: 1 });
  });

  it("names the block a JOINED part STARTS at, because that is what the part is", () => {
    // The other half of the same change. Adjacent text parts join at the wire
    // (`joinTextParts`), so two unhinted sections are ONE part — and one part
    // gets one origin, naming where it begins. The alternative is a provenance
    // array that no longer indexes the request it describes, which is the one
    // way this mechanism can be actively harmful.
    const t = tree(system(sectionBlock("A", "first"), sectionBlock("B", "second")));
    expectAligned(t);
    const p = buildMessageProvenance(t);
    expect(p[0]).toHaveLength(1);
    expect(p[0]?.[0]?.blockIndex).toBe(0);
  });

  it("returns undefined for an out-of-range lookup rather than throwing", () => {
    const p = buildMessageProvenance(t);
    expect(p[99]?.[0]).toBeUndefined();
    expect(p[1]?.[99]).toBeUndefined();
  });
});
