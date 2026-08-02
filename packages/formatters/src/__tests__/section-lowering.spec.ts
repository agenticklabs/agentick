/**
 * The one section → content lowering (ADR 94).
 *
 * `# ${title}` used to be hardcoded inside the model projection, which meant
 * a tree rendered under `<XML>` still emitted markdown headings for its
 * sections — the formatter was bypassed for the one construct whose whole
 * job is structure. The rule lives here now, and it is written once for both
 * cases the compiler has: a section inside a message, and a free-floating
 * section (which becomes a `grounding` message wrapping exactly these
 * blocks).
 */

import { describe, expect, it } from "vitest";
import type { ContentBlock } from "@agentick/spec";

import { lowerSection, sectionTagName, SECTION_STAMP } from "../section-lowering.js";

const text = (t: string): ContentBlock => ({ type: "text", text: t });

describe("markdown (the default dialect)", () => {
  it("emits the exact bytes the old sectionText produced", () => {
    // `["# " + title, ...texts].join("\n")`. Pinned because every prompt that
    // ever contained a section re-tokenizes if this drifts.
    const [block] = lowerSection({ id: "s", title: "Identity", content: [text("You are E.")] });
    expect(block).toMatchObject({ type: "text", text: "# Identity\nYou are E." });
  });

  it("joins several text blocks with single newlines, as one block", () => {
    // One block is one projected message part, and providers do not agree on
    // how they join parts — so the section decides its own internal layout
    // rather than leaving it to whichever adapter runs.
    const out = lowerSection({ id: "s", title: "T", content: [text("a"), text("b")] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ text: "# T\na\nb" });
  });

  it("emits no heading for an untitled section", () => {
    const out = lowerSection({ id: "s", content: [text("body")] });
    expect(out[0]).toMatchObject({ text: "body" });
  });

  it("emits nothing at all for an empty untitled section", () => {
    expect(lowerSection({ id: "s", content: [] })).toEqual([]);
  });

  it("keeps a title even with no body", () => {
    expect(lowerSection({ id: "s", title: "T", content: [] })[0]).toMatchObject({ text: "# T" });
  });
});

describe("xml", () => {
  const xml = { id: "formatter.xml", format: "xml" } as const;

  it("makes the title the TAG NAME", () => {
    const [block] = lowerSection({ id: "s", title: "Current User", content: [text("Ryan")] }, xml);
    expect(block).toMatchObject({ text: "<current_user>\nRyan\n</current_user>" });
  });

  it("falls back to <section id> for an untitled section", () => {
    const [block] = lowerSection({ id: "sec.7", content: [text("body")] }, xml);
    expect(block).toMatchObject({ text: '<section id="sec.7">\nbody\n</section>' });
  });

  it("escapes the id when it lands in attribute position", () => {
    const [block] = lowerSection({ id: 'a"b', content: [text("x")] }, xml);
    expect(block).toMatchObject({ text: '<section id="a&quot;b">\nx\n</section>' });
  });
});

describe("the slug rule", () => {
  it.each([
    ["Current User", "current_user"],
    ["Todos", "todos"],
    ["User's Context!", "user_s_context"],
    ["  spaced  out  ", "spaced_out"],
    ["Already_Snake", "already_snake"],
    ["A -- B", "a_b"],
  ])("%s → %s", (title, slug) => {
    expect(sectionTagName(title)).toBe(slug);
  });

  it("prefixes a leading digit rather than dropping the token", () => {
    // `2 Factor Auth` and `Factor Auth` must not collide; a tag may not start
    // with a digit, so the prefix is the cheapest way to keep both.
    expect(sectionTagName("2 Factor Auth")).toBe("_2_factor_auth");
  });

  it("returns undefined when nothing survives, so the caller can fall back", () => {
    expect(sectionTagName("???")).toBeUndefined();
  });
});

describe("what rides the blocks", () => {
  it("stamps the section id on every block it produces", () => {
    const out = lowerSection({
      id: "sec.1",
      title: "T",
      content: [text("a"), { type: "image", source: { type: "url", url: "u" } } as ContentBlock],
    });
    expect(out.every((b) => b.id === "sec.1")).toBe(true);
    expect(out.every((b) => b.metadata?.[SECTION_STAMP] === "sec.1")).toBe(true);
  });

  it("puts the cache hint on the LAST block — the breakpoint closes over it", () => {
    const out = lowerSection({
      id: "s",
      title: "T",
      content: [text("a")],
      cache: { ttl: "1h" },
    });
    expect(out[out.length - 1]).toMatchObject({ cache: { ttl: "1h" } });
  });

  it("puts per-section providerMetadata on the LAST block", () => {
    const out = lowerSection({
      id: "s",
      content: [text("a")],
      providerMetadata: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
    expect(out[0]).toMatchObject({
      providerMetadata: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  });
});

describe("no silent drop", () => {
  it("breaks the text run around a non-text block and keeps both", () => {
    const image = { type: "image", source: { type: "url", url: "u" } } as ContentBlock;
    const out = lowerSection({
      id: "s",
      title: "T",
      content: [text("before"), image, text("after")],
    });
    expect(out.map((b) => b.type)).toEqual(["text", "image", "text"]);
    expect(out[0]).toMatchObject({ text: "# T\nbefore" });
    expect(out[2]).toMatchObject({ text: "after" });
  });

  it("keeps a block whose content is still a semantic sidecar", () => {
    // Lowering runs during collect, BEFORE the formatter pass — a block with
    // a sidecar has an empty `text` and its content in the tree. Joining it
    // as text would erase it.
    const semantic = {
      type: "text",
      text: "",
      semanticNode: { children: [{ text: "hi" }] },
    } as unknown as ContentBlock;
    const out = lowerSection({ id: "s", title: "T", content: [semantic] });
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ semanticNode: { children: [{ text: "hi" }] } });
  });
});

describe("author metadata", () => {
  it("rides every block, so it survives a section landing INSIDE a message", () => {
    // There is no section entry left to carry it — inside a message the only
    // thing that reaches the IR is the blocks, so anything the author put on
    // the section has to be on them or it is silently dropped.
    const out = lowerSection({
      id: "s",
      title: "T",
      content: [text("a")],
      metadata: { origin: "crm" },
    });
    expect(out[0]?.metadata).toMatchObject({ origin: "crm", [SECTION_STAMP]: "s" });
  });

  it("never lets author metadata shadow the section stamp", () => {
    const out = lowerSection({
      id: "s",
      content: [text("a")],
      metadata: { [SECTION_STAMP]: "spoofed" },
    });
    expect(out[0]?.metadata?.[SECTION_STAMP]).toBe("s");
  });
});
