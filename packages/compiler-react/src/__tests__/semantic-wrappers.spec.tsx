/**
 * Semantic BLOCK wrappers (`<H1>`–`<H3>`, `<Paragraph>`) — the uppercase
 * author-facing sugar over the semantic-HTML intrinsics.
 *
 * The claim under test is that the sugar reaches the SAME output as the
 * lowercase intrinsic it wraps: `<H2>Title</H2>` ≡ `<h2>Title</h2>`. A wrapper
 * that emits an intrinsic NO contributor claims is worse than a missing
 * component — the walker has nothing to collect, so the heading silently
 * DISAPPEARS from the compiled context instead of failing loudly.
 *
 * Runs through the real `CompilerHarness` (render → collect → formatter pass),
 * so the assertions are on the wire-shape text a model would see.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { fakeBridges } from "@agentick/compiler";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";

import { CompilerHarness } from "../harness/compiler-harness.js";
import { H1, H2, H3, Paragraph } from "../react/components/semantic.js";
import { Message } from "../react/components/message.js";
import { Section } from "../react/components/section.js";

let seq = 0;

/** Render an element through the real pipeline and return the first entry. */
async function renderEntry(element: React.ReactElement): Promise<{
  readonly role: string;
  readonly content: readonly { type: string; text?: string }[];
}> {
  const harness = new CompilerHarness(
    `h_semw_${seq}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  const mountId = `m_semw_${seq++}`;
  await harness.mount({ mountId, sessionId: "s", element, bridges: fakeBridges() });
  const { tree } = await harness.renderTree({ mountId, sessionId: "s" });
  const entry = tree.context.entries[0];
  if (entry === undefined) throw new Error("no context entries produced");
  return entry as unknown as {
    role: string;
    content: readonly { type: string; text?: string }[];
  };
}

const textOf = (entry: { content: readonly { text?: string }[] }): string =>
  entry.content.map((b) => b.text ?? "").join("");

describe("semantic block wrappers — heading semantics survive to compiled output", () => {
  it("<H1> renders as a level-1 heading", async () => {
    const entry = await renderEntry(
      <Message role="user">
        <H1>Title</H1>
      </Message>,
    );
    expect(textOf(entry)).toBe("# Title\n\n");
  });

  it("<H2> renders as a level-2 heading", async () => {
    const entry = await renderEntry(
      <Message role="user">
        <H2>Subtitle</H2>
      </Message>,
    );
    expect(textOf(entry)).toBe("## Subtitle\n\n");
  });

  it("<H3> renders as a level-3 heading", async () => {
    const entry = await renderEntry(
      <Message role="user">
        <H3>Sub-subtitle</H3>
      </Message>,
    );
    expect(textOf(entry)).toBe("### Sub-subtitle\n\n");
  });

  it("<Paragraph> renders as a paragraph block", async () => {
    const entry = await renderEntry(
      <Message role="user">
        <Paragraph>Body copy.</Paragraph>
      </Message>,
    );
    expect(textOf(entry)).toBe("Body copy.\n\n");
  });

  it("the sugar is byte-identical to the lowercase intrinsic it wraps", async () => {
    const sugar = await renderEntry(
      <Message role="user">
        <H2>Same</H2>
      </Message>,
    );
    const intrinsic = await renderEntry(
      React.createElement("message", { role: "user" }, React.createElement("h2", null, "Same")),
    );
    expect(textOf(sugar)).toBe(textOf(intrinsic));
  });

  it("headings + paragraphs compose inside a <Section>, in document order", async () => {
    const entry = await renderEntry(
      <Section id="doc">
        <H2>Heading</H2>
        <Paragraph>First.</Paragraph>
        <H3>Nested</H3>
        <Paragraph>Second.</Paragraph>
      </Section>,
    );
    // A free-floating section is a `grounding` message (ADR 94); the
    // untitled one here contributes no frame, so the semantic run reaches
    // the same bytes it would in any other container.
    expect(entry.role).toBe("grounding");
    expect(textOf(entry)).toBe("## Heading\n\nFirst.\n\n### Nested\n\nSecond.\n\n");
  });

  it("inline semantics nest inside a heading and a paragraph", async () => {
    const entry = await renderEntry(
      <Message role="user">
        <H2>
          Hello <strong>world</strong>
        </H2>
        <Paragraph>
          See <em>this</em>.
        </Paragraph>
      </Message>,
    );
    expect(textOf(entry)).toBe("## Hello **world**\n\nSee *this*.\n\n");
  });
});
