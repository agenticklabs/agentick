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

import { markdownFormatter } from "../markdown.js";
import {
  expandSections,
  lowerSection,
  sectionBlock,
  sectionTagName,
  SECTION_STAMP,
} from "../section-lowering.js";
import { xmlFormatter } from "../xml.js";

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
    // `lowerSection` is public and takes whatever it is handed. A block with
    // a sidecar has an empty `text` and its content in the tree, so joining it
    // as text would erase it. (Through `expandSections` this cannot happen —
    // the body is rendered first — which is what the carrier suite pins.)
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

describe("the carrier — collect emits structure, the formatter lowers it", () => {
  it("renders the body BEFORE framing it, so the frame is never escaped", () => {
    // The whole reason lowering moved out of the collect walk. A frame
    // emitted during collect would be escaped by the formatter pass that runs
    // after it; a body lowered during collect would be escaped twice.
    const out = xmlFormatter([
      sectionBlock({ id: "s", title: "Current User", content: [text("Ryan & Bob")] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ text: "<current_user>\nRyan &amp; Bob\n</current_user>" });
  });

  it("lowers the SAME carrier differently per dialect — one section, two dialects", () => {
    const carrier = sectionBlock({ id: "s", title: "Current User", content: [text("Ryan")] });
    expect(markdownFormatter([carrier])[0]).toMatchObject({ text: "# Current User\nRyan" });
    expect(xmlFormatter([carrier])[0]).toMatchObject({
      text: "<current_user>\nRyan\n</current_user>",
    });
  });

  it("collapses a semantic-sidecar body into the section's own block", () => {
    // Pre-thread-through this was two blocks: a title block from the collect
    // lowering, and the rendered prose from the formatter pass.
    const body = {
      type: "text",
      text: "",
      semanticNode: { semantic: "strong", children: [{ text: "loud" }] },
    } as unknown as ContentBlock;
    const out = markdownFormatter([sectionBlock({ id: "s", title: "T", content: [body] })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ text: "# T\n**loud**" });
  });

  it("joins two adjacent sections with a blank line", () => {
    // The rule that used to live in the collect walker's `coalesce`, moved
    // here with the lowering. Byte-identical: two sections in one message are
    // one block separated by `\n\n`, because a provider may concatenate text
    // parts with no separator of its own.
    const out = markdownFormatter([
      sectionBlock({ id: "a", title: "A", content: [text("first")] }),
      sectionBlock({ id: "b", title: "B", content: [text("second")] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ text: "# A\nfirst\n\n# B\nsecond" });
  });

  it("refuses to merge across a cache breakpoint — the boundary IS the block", () => {
    const out = markdownFormatter([
      sectionBlock({ id: "a", title: "A", content: [text("first")], cache: { ttl: "1h" } }),
      sectionBlock({ id: "b", title: "B", content: [text("second")] }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ text: "# A\nfirst", cache: { ttl: "1h" } });
  });

  it("passes non-carrier blocks through the formatter untouched", () => {
    const out = markdownFormatter([
      text("before"),
      sectionBlock({ id: "s", title: "T", content: [text("inside")] }),
      { type: "code", language: "go", text: "package main" } as ContentBlock,
    ]);
    expect(out.map((b) => b.type)).toEqual(["text", "text", "text"]);
    expect(out[0]).toMatchObject({ text: "before" });
    expect(out[1]).toMatchObject({ text: "# T\ninside" });
    expect(out[2]).toMatchObject({ text: "```go\npackage main\n```" });
  });

  it("is a no-op allocation-wise when there is no carrier at all", () => {
    const render = (blocks: readonly ContentBlock[]): readonly ContentBlock[] => blocks;
    const blocks = [text("a"), text("b")];
    expect(expandSections(blocks, render, { id: "x" })).toBe(blocks);
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
