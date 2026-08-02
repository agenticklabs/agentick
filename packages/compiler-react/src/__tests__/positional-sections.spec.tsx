/**
 * ADR 94 — container decides role, position decides order.
 *
 * A `<Section>` is content. Where its content LANDS is decided by what
 * contains it, and where it lands in the ORDER is decided by where it was
 * written. Those two sentences are the whole law, and this suite is them as
 * assertions:
 *
 *   - inside `<System>` / `<User>` / any message → that message's content.
 *     `<System>` is not special; it is the message whose content becomes the
 *     provider's system parameter. This is also the fix for the next.17
 *     silent drop, where a section nested in a message fell off the walker's
 *     fragment switch and vanished with no diagnostic.
 *   - free-floating → an anonymous `grounding` message AT ITS OWN POSITION.
 *
 * The first three tests are CONSERVATION pins, written against bytes
 * captured from the pre-ADR-94 pipeline. They are what makes this a
 * refactor of the fold rather than a rewrite of the output.
 *
 * @see docs/proposals/v2/blueprint/94-positional-sections.md
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { fakeBridges } from "@agentick/compiler";
import { markdownFormatter } from "@agentick/formatters";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { MessageEntry, RenderedTree } from "@agentick/spec";

import { CompilerHarness } from "../harness/compiler-harness.js";
import {
  Assistant,
  Grounding,
  H1,
  H2,
  Paragraph,
  System,
  User,
} from "../react/components/semantic.js";
import { Section } from "../react/components/section.js";
import { Message } from "../react/components/message.js";
import { FormatScope, Markdown, PlainText, XML } from "../react/components/format-scope.js";

let seq = 0;

async function compile(element: React.ReactElement): Promise<RenderedTree> {
  const harness = new CompilerHarness(
    `h_pos_${seq}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  const mountId = `m_pos_${seq++}`;
  await harness.mount({ mountId, sessionId: "s", element, bridges: fakeBridges() });
  const { tree } = await harness.renderTree({ mountId, sessionId: "s" });
  return tree;
}

const entries = (tree: RenderedTree): readonly MessageEntry[] => tree.context.entries;
const textOf = (entry: MessageEntry): string =>
  entry.content.map((b) => ("text" in b ? (b.text as string) : "")).join("");
const codesOf = (tree: RenderedTree): readonly string[] =>
  (tree.diagnostics?.diagnostics ?? []).map((d) => d.code ?? "");

// ---------------------------------------------------------------------------
// Conservation — what must NOT have changed
// ---------------------------------------------------------------------------

describe("conservation", () => {
  it("leaves an ernesto-style semantic-HTML system prompt byte-identical", async () => {
    // The shape adopters use TODAY to route around the next.17 drop: headings
    // and paragraphs directly inside `<System>`, no `<Section>` anywhere.
    // These bytes were captured from the pipeline before ADR 94 landed.
    const tree = await compile(
      <>
        <System>
          <H1>Identity</H1>
          <Paragraph>You are Ernesto.</Paragraph>
          <H2>Rules</H2>
          <Paragraph>Be terse.</Paragraph>
        </System>
        <User>hello</User>
      </>,
    );
    const [system] = entries(tree);
    expect(system?.role).toBe("system");
    expect(system?.content).toHaveLength(1);
    expect(textOf(system!)).toBe("# Identity\n\nYou are Ernesto.\n\n## Rules\n\nBe terse.\n\n");
  });

  it("lowers a title+text section to the exact bytes the old sectionText produced", async () => {
    // `sectionText` was `["# " + title, ...texts].join("\n")`. One heading
    // line, single newline, no blank line. Anything else re-tokenizes every
    // prompt that ever contained a section.
    const tree = await compile(<Section title="Identity">You are Ernesto.</Section>);
    expect(textOf(entries(tree)[0]!)).toBe("# Identity\nYou are Ernesto.");
  });

  it("joins two sections in one message the way the old system blob did", async () => {
    // `collectSectionText` joined sections with a blank line, and the bytes
    // have not moved. What changed is WHERE the join is applied: two sections
    // are two BLOCKS here, each naming itself, and the blank line goes in at
    // the two exits from the IR — `blocksToText` on the string path (pinned
    // below) and `joinTextParts` on the wire path (pinned in
    // `@agentick/model`'s cache-hints suite, which is where a provider
    // concatenating text parts with no separator is a fact).
    const tree = await compile(
      <System>
        <Section title="A">first</Section>
        <Section title="B">second</Section>
      </System>,
    );
    const [system] = entries(tree);
    expect(system?.content).toHaveLength(2);
    expect(system?.content[0]).toMatchObject({ text: "# A\nfirst", id: expect.any(String) });
    expect(markdownFormatter.blocksToText!(system!.content)).toBe("# A\nfirst\n\n# B\nsecond");
  });

  it("keeps both sections separately attributable — one block, one id, each", async () => {
    // Impossible while the two blocks merged: the merged block could carry
    // only ONE id, so the second section's id reached nothing downstream and
    // its bytes could not be attributed to it by provenance or anything else.
    const tree = await compile(
      <System>
        <Section id="sec.a" title="A">
          first
        </Section>
        <Section id="sec.b" title="B">
          second
        </Section>
      </System>,
    );
    const [system] = entries(tree);
    expect(system?.content.map((b) => b.id)).toEqual(["sec.a", "sec.b"]);
    expect(system?.content.map((b) => b.metadata?.section)).toEqual(["sec.a", "sec.b"]);
  });
});

// ---------------------------------------------------------------------------
// Container decides role
// ---------------------------------------------------------------------------

describe("a section inside a message becomes that message's content", () => {
  it("inside <System> — which is just the message that becomes the system param", async () => {
    // BEFORE ADR 94 this compiled to `content: []`. The section was silently
    // dropped: its fragment was neither a content-block nor a semantic-node,
    // so the message's content walker ignored it.
    const tree = await compile(
      <System>
        <Section title="Identity">You are Ernesto.</Section>
      </System>,
    );
    expect(entries(tree)).toHaveLength(1);
    expect(entries(tree)[0]?.role).toBe("system");
    expect(textOf(entries(tree)[0]!)).toBe("# Identity\nYou are Ernesto.");
  });

  it("inside <User> — same structure, no special case for the role", async () => {
    const tree = await compile(
      <User>
        <Section title="Attached file">contents here</Section>
      </User>,
    );
    expect(entries(tree)).toHaveLength(1);
    expect(entries(tree)[0]?.role).toBe("user");
    expect(textOf(entries(tree)[0]!)).toBe("# Attached file\ncontents here");
  });

  it("inside <Assistant> too — the rule is uniform over every role", async () => {
    const tree = await compile(
      <Assistant>
        <Section title="Plan">step one</Section>
      </Assistant>,
    );
    expect(entries(tree)[0]?.role).toBe("assistant");
    expect(textOf(entries(tree)[0]!)).toBe("# Plan\nstep one");
  });

  it("keeps a cache-hinted section as its own block — one part, one breakpoint", async () => {
    // #185, one level down. The breakpoint used to be a property of a section
    // ENTRY; it is now a property of the block the section lowered to, which
    // is what `messagePartFromBlock` forwards onto the projected part.
    const tree = await compile(
      <System>
        <Section title="Stable" cache={{ ttl: "1h" }}>
          expensive prefix
        </Section>
        <Section title="Volatile">changes every turn</Section>
      </System>,
    );
    const [system] = entries(tree);
    expect(system?.content).toHaveLength(2);
    expect(system?.content[0]).toMatchObject({
      text: "# Stable\nexpensive prefix",
      cache: { ttl: "1h" },
    });
    expect(system?.content[1]).not.toHaveProperty("cache");
  });

  it("passes a non-text block through rather than dropping it", async () => {
    const tree = await compile(
      <User>
        <Section title="Evidence">
          look at this
          <Message content={[]} role="user" />
        </Section>
      </User>,
    );
    // The point is only that the section's text survives alongside whatever
    // else it contained — no silent drop in either direction.
    expect(textOf(entries(tree)[0]!)).toContain("# Evidence");
  });
});

// ---------------------------------------------------------------------------
// Position decides order
// ---------------------------------------------------------------------------

describe("a free-floating section is a grounding message at its own position", () => {
  it("lands between the two messages it was written between", async () => {
    const tree = await compile(
      <>
        <System>rules</System>
        <User>hello</User>
        <Section title="Current User">Ryan</Section>
        <Assistant>hi</Assistant>
      </>,
    );
    expect(entries(tree).map((e) => e.role)).toEqual(["system", "user", "grounding", "assistant"]);
    expect(textOf(entries(tree)[2]!)).toBe("# Current User\nRyan");
  });

  it("is the LAST entry when it is written last", async () => {
    // The headline consequence. Before ADR 94 this section was hoisted to the
    // front of the system prompt — rendered JSX did not match compiled input.
    const tree = await compile(
      <>
        <System>rules</System>
        <User>hello</User>
        <Section title="Current User">Ryan</Section>
      </>,
    );
    const last = entries(tree)[entries(tree).length - 1];
    expect(last?.role).toBe("grounding");
    expect(textOf(last!)).toBe("# Current User\nRyan");
  });

  it("carries the section's stable id, so provenance can still name it", async () => {
    const tree = await compile(
      <Section id="current-user" title="Current User">
        Ryan
      </Section>,
    );
    expect(entries(tree)[0]?.id).toBe("current-user");
    expect(entries(tree)[0]?.content[0]).toMatchObject({ id: "current-user" });
  });

  it("defaults to grounding when no role is named", async () => {
    const tree = await compile(<Section title="Current User">Ryan</Section>);
    expect(entries(tree)[0]?.role).toBe("grounding");
  });

  it("takes the role the author names, wrapper and all", async () => {
    // The escape hatch on the anonymous-box default. `grounding` is the right
    // default for non-conversational context, but a section that IS a turn
    // says so — and the section structure still wraps it, so what changed is
    // the role, not the content.
    const tree = await compile(
      <>
        <System>rules</System>
        <Section role="user" title="Attached file">
          contents here
        </Section>
      </>,
    );
    const last = entries(tree)[1];
    expect(last?.role).toBe("user");
    expect(textOf(last!)).toBe("# Attached file\ncontents here");
  });

  it("carries an author role that is not a provider role, for the adapter to lower", async () => {
    const tree = await compile(
      <>
        <System>rules</System>
        <Section role="event" title="Deploy">
          shipped v2
        </Section>
      </>,
    );
    expect(entries(tree)[1]?.role).toBe("event");
  });

  it('treats role="system" as a system entry, mid-stream rule and all', async () => {
    const tree = await compile(
      <>
        <User>hello</User>
        <Section role="system" title="Late">
          rules
        </Section>
      </>,
    );
    expect(entries(tree)[1]?.role).toBe("system");
    expect(codesOf(tree)).toContain("MID_STREAM_SYSTEM");
  });

  it("is what <Grounding> spells out explicitly", async () => {
    // `<Grounding>` is a `grounding` message wrapping a `<Section>` — the
    // same thing a bare section folds to, written out.
    const bare = await compile(<Section title="Current User">Ryan</Section>);
    const explicit = await compile(<Grounding title="Current User">Ryan</Grounding>);
    expect(entries(explicit)[0]?.role).toBe("grounding");
    expect(textOf(entries(explicit)[0]!)).toBe(textOf(entries(bare)[0]!));
  });
});

// ---------------------------------------------------------------------------
// The formatter pass owns the dialect
// ---------------------------------------------------------------------------

describe("the dialect in scope decides how a section reads", () => {
  it("makes the title the TAG under <XML>, framed once and escaped once", async () => {
    const tree = await compile(
      <XML>
        <Section title="Current User">Ryan &amp; Bob</Section>
      </XML>,
    );
    const [entry] = entries(tree);
    expect(textOf(entry!)).toBe("<current_user>\nRyan &amp; Bob\n</current_user>");
    // The whole point of lowering AFTER the body is rendered: the tag never
    // meets the escaper, and the body meets it exactly once. A frame emitted
    // before the escaping ran would read `&lt;current_user&gt;`; a body
    // escaped twice would read `&amp;amp;`.
    expect(textOf(entry!)).not.toContain("&lt;current_user&gt;");
    expect(textOf(entry!)).not.toContain("&amp;amp;");
  });

  it("lowers a section inside <System> in the dialect too", async () => {
    // `<System>` is not special — it is the message whose content becomes the
    // provider system param. Its content is lowered by the message's own
    // formatter, so a system prompt written under `<XML>` is xml all the way
    // down rather than xml framing around markdown headings.
    const tree = await compile(
      <XML>
        <System>
          <Section title="Identity">You are Ernesto.</Section>
        </System>
      </XML>,
    );
    const [system] = entries(tree);
    expect(system?.role).toBe("system");
    expect(textOf(system!)).toBe("<identity>\nYou are Ernesto.\n</identity>");
  });

  it("drops the heading marker under <PlainText> — text has no heading syntax", async () => {
    const tree = await compile(
      <PlainText>
        <Section title="Current User">Ryan</Section>
      </PlainText>,
    );
    expect(textOf(entries(tree)[0]!)).toBe("Current User\nRyan");
  });

  it("stamps renderedWith with the formatter that ACTUALLY lowered the section", async () => {
    // The ref was always stamped; before the thread-through it named a
    // dialect that had not run. Now the two cannot disagree.
    const tree = await compile(
      <>
        <XML>
          <Section title="A">one</Section>
        </XML>
        <Section title="B">two</Section>
      </>,
    );
    const [xml, md] = entries(tree);
    expect(xml?.renderedWith?.format).toBe("xml");
    expect(textOf(xml!)).toBe("<a>\none\n</a>");
    expect(md?.renderedWith?.format).toBe("markdown");
    expect(textOf(md!)).toBe("# B\ntwo");
  });

  it("lowers a semantic-HTML body into ONE block with its title", async () => {
    // The split-block symptom: lowering used to run at collect, BEFORE the
    // semantic sidecar had any text in it, so the title became one block and
    // the rendered prose another. One lowering, one block.
    const tree = await compile(
      <Section title="Identity">
        <Paragraph>You are Ernesto.</Paragraph>
      </Section>,
    );
    const [entry] = entries(tree);
    expect(entry?.content).toHaveLength(1);
    expect(textOf(entry!)).toBe("# Identity\nYou are Ernesto.\n\n");
  });

  it("lowers a NESTED section in the same dialect as its parent", async () => {
    const tree = await compile(
      <XML>
        <Section title="Outer">
          <Section title="Inner">deep</Section>
        </Section>
      </XML>,
    );
    expect(textOf(entries(tree)[0]!)).toBe("<outer>\n<inner>\ndeep\n</inner>\n</outer>");
  });
});

// ---------------------------------------------------------------------------
// Islands — the nearest DECLARED scope overrides the container's dialect
// ---------------------------------------------------------------------------

describe("a section that declares its own dialect is an island", () => {
  it("puts an XML island inside a markdown <System>, verbatim", async () => {
    // The ubiquitous hand-written-prompt shape: markdown prose with a literal
    // tagged block in it. The island's bytes are NOT re-rendered by the outer
    // dialect — escaping them would emit `&lt;current_user&gt;`, a rendering
    // OF an island rather than an island.
    const tree = await compile(
      <System>
        Follow the rules.
        <XML>
          <Section title="Current User">Ryan &amp; Bob</Section>
        </XML>
      </System>,
    );
    const [system] = entries(tree);
    expect(system?.role).toBe("system");
    expect(textOf(system!)).toBe(
      "Follow the rules.<current_user>\nRyan &amp; Bob\n</current_user>",
    );
    expect(textOf(system!)).not.toContain("&lt;current_user&gt;");
  });

  it("puts a markdown island inside an XML <System>, `&` raw and all", async () => {
    // The mirror, and the honest consequence: markdown does not escape and the
    // outer xml never sees these bytes, so the `&` stays raw. Well-formedness
    // across a declared boundary is the author's call.
    const tree = await compile(
      <XML>
        <System>
          <Markdown>
            <Section title="Notes">Ryan &amp; Bob</Section>
          </Markdown>
        </System>
      </XML>,
    );
    expect(textOf(entries(tree)[0]!)).toBe("# Notes\nRyan & Bob");
  });

  it("leaves same-dialect nesting alone — the stamp usually names the container", async () => {
    const tree = await compile(
      <System>
        <Section title="Identity">You are Ernesto.</Section>
      </System>,
    );
    expect(textOf(entries(tree)[0]!)).toBe("# Identity\nYou are Ernesto.");
  });

  it("obeys a purpose-scoped FormatScope, which used to stamp a ref and ignore it", async () => {
    // `<FormatScope purpose="section">` resolved a formatter for sections and
    // then rendered them in the message's dialect anyway — a knob that lied.
    const tree = await compile(
      <FormatScope formatter={{ id: "xml", format: "xml" }} purpose="section">
        <System>
          <Section title="Current User">Ryan</Section>
        </System>
      </FormatScope>,
    );
    const [system] = entries(tree);
    expect(system?.renderedWith?.format).toBe("markdown");
    expect(textOf(system!)).toBe("<current_user>\nRyan\n</current_user>");
  });
});

// ---------------------------------------------------------------------------
// Diagnostics — enforcement at compile time, not by silent folding
// ---------------------------------------------------------------------------

describe("diagnostics", () => {
  it("names the <System> fix when a bare section leads the tree", async () => {
    const tree = await compile(
      <>
        <Section>You are a helpful assistant.</Section>
        <User>hello</User>
      </>,
    );
    const diag = (tree.diagnostics?.diagnostics ?? []).find(
      (d) => d.code === "SECTION_WITHOUT_SYSTEM",
    );
    expect(diag).toBeDefined();
    // The migration is mechanical, so the diagnostic performs it in prose.
    expect(diag?.message).toContain("wrap it in <System>");
    // A hint, NOT a shim: the section still compiles to grounding at its
    // position. Nothing is folded back into the system prompt.
    expect(entries(tree)[0]?.role).toBe("grounding");
  });

  it("stays quiet when the section follows a <System>", async () => {
    const tree = await compile(
      <>
        <System>rules</System>
        <Section title="Current User">Ryan</Section>
      </>,
    );
    expect(codesOf(tree)).not.toContain("SECTION_WITHOUT_SYSTEM");
  });

  it("stays quiet for a section INSIDE <System> — it never leaves the message", async () => {
    const tree = await compile(
      <System>
        <Section title="Identity">You are Ernesto.</Section>
      </System>,
    );
    expect(codesOf(tree)).not.toContain("SECTION_WITHOUT_SYSTEM");
  });

  it("flags a role on a section NESTED in a message — the container already decided", async () => {
    // Not silently ignored: a dropped prop reads as a framework bug rather
    // than a tree bug.
    const tree = await compile(
      <User>
        <Section role="assistant" title="Notes">
          x
        </Section>
      </User>,
    );
    const diag = (tree.diagnostics?.diagnostics ?? []).find(
      (d) => d.code === "SECTION_ROLE_IN_MESSAGE",
    );
    expect(diag).toBeDefined();
    expect(diag?.message).toContain('<Message role="assistant">');
    // The section's CONTENT still lands where it belongs; only the role prop
    // is refused.
    expect(entries(tree)[0]?.role).toBe("user");
    expect(textOf(entries(tree)[0]!)).toBe("# Notes\nx");
  });

  it("stays quiet for a role on a free-standing section", async () => {
    const tree = await compile(
      <>
        <System>rules</System>
        <Section role="user">hello</Section>
      </>,
    );
    expect(codesOf(tree)).not.toContain("SECTION_ROLE_IN_MESSAGE");
  });

  it("does not hint at <System> when the author named a role deliberately", async () => {
    const tree = await compile(<Section role="user">hello</Section>);
    expect(codesOf(tree)).not.toContain("SECTION_WITHOUT_SYSTEM");
  });

  it("flags a <System> at or after the first non-system message", async () => {
    const tree = await compile(
      <>
        <User>hello</User>
        <System>rules</System>
      </>,
    );
    expect(codesOf(tree)).toContain("MID_STREAM_SYSTEM");
  });

  it("does not flag several LEADING <System> messages", async () => {
    const tree = await compile(
      <>
        <System>identity</System>
        <System>rules</System>
        <User>hello</User>
      </>,
    );
    expect(codesOf(tree)).not.toContain("MID_STREAM_SYSTEM");
  });
});
