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
import type { ContentBlock, MessageEntry, RenderedTree, SectionEntry } from "@agentick/spec";
import { SPEC_VERSION } from "@agentick/spec";

import { buildMessages } from "../canonical-projection.js";
import { buildMessageProvenance } from "../provenance.js";

const text = (t: string): ContentBlock => ({ type: "text", text: t }) as ContentBlock;
const imageRef = (fileId: string): ContentBlock =>
  ({ type: "image", source: { type: "reference", fileId } }) as ContentBlock;

const msg = (role: string, content: readonly ContentBlock[], id?: string): MessageEntry =>
  ({ kind: "message", role, content, ...(id !== undefined ? { id } : {}) }) as MessageEntry;

let sectionSeq = 0;
const section = (title: string, body: string, cache?: unknown): SectionEntry =>
  ({
    kind: "section",
    id: `sec-${++sectionSeq}`,
    title,
    content: [text(body)],
    ...(cache !== undefined ? { metadata: { cache } } : {}),
  }) as SectionEntry;

const tree = (...entries: Array<MessageEntry | SectionEntry>): RenderedTree =>
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

  it("holds with a leading system message from sections", () => {
    expectAligned(tree(section("Rules", "be terse"), msg("user", [text("hi")], "m1")));
  });

  it("holds with CACHE-HINTED sections, which emit one part per section", () => {
    // The shape that would break a naive walk: `buildMessages` switches from one joined
    // blob to one part per section, so a provenance walk that assumed a single system part
    // would be off by N-1 for every message after it.
    expectAligned(
      tree(
        section("A", "first", { type: "ephemeral" }),
        section("B", "second", { type: "ephemeral" }),
        msg("user", [text("hi")], "m1"),
      ),
    );
  });

  it("holds when a section is EMPTY and contributes no part", () => {
    // An empty section is filtered out of the parts list. Counting sections rather than
    // non-empty sections would over-count.
    expectAligned(
      tree(
        section("A", "", { type: "ephemeral" }),
        section("B", "second", { type: "ephemeral" }),
        msg("user", [text("hi")], "m1"),
      ),
    );
  });

  it("holds when there are NO sections at all (no system message)", () => {
    expectAligned(tree(msg("user", [text("hi")], "m1")));
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
    section("Rules", "be terse"),
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

  it("is undefined for a SYSTEM part — sections are not something to quarantine", () => {
    // Framework-rendered context, not a user attachment. There is no id to name and
    // nothing a quarantine could act on, so `undefined` is the honest answer.
    expect(buildMessageProvenance(t)[0]?.[0]).toBeUndefined();
  });

  it("omits entryId for an ID-LESS entry rather than inventing one", () => {
    // A synthesized entry or a hand-built tree. Attribution still narrows to a block, but
    // nothing DURABLE can be recorded — which is a real limitation, stated rather than
    // papered over with a fabricated key.
    const p = buildMessageProvenance(tree(msg("user", [imageRef("f-1")])));
    expect(p[0]![0]).toEqual({ blockIndex: 0 });
    expect(p[0]![0]).not.toHaveProperty("entryId");
  });

  it("returns undefined for an out-of-range lookup rather than throwing", () => {
    const p = buildMessageProvenance(t);
    expect(p[99]?.[0]).toBeUndefined();
    expect(p[1]?.[99]).toBeUndefined();
  });
});
