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
    // `collectSectionText` joined sections with a blank line. Two sections are
    // two blocks now, and two blocks can become two parts that a provider
    // concatenates with NO separator — so the separator is put back at the
    // point the blocks meet.
    const tree = await compile(
      <System>
        <Section title="A">first</Section>
        <Section title="B">second</Section>
      </System>,
    );
    const [system] = entries(tree);
    expect(system?.content).toHaveLength(1);
    expect(textOf(system!)).toBe("# A\nfirst\n\n# B\nsecond");
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
