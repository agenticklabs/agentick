/**
 * Event blocks carry structure; the formatter derives the text.
 *
 * Every dialect previously rendered `block.text ?? ""` and dropped the payload
 * entirely — an event with no author-supplied `text` reached the model as an
 * empty string. That made `text` mandatory in practice, which pushed a
 * rendering into the durable timeline: replay it after changing formatters and
 * you get last month's markup.
 */

import { describe, expect, it } from "vitest";

import type { SemanticContentBlock } from "@agentick/spec";
import { markdownFormatter, textFormatter, xmlFormatter } from "../index.js";

const compaction = {
  type: "system_event" as const,
  event: "compaction",
  source: "timeline",
  data: { summary: "Discussed the store substrate.", entriesBefore: 42 },
};

const xmlText = (b: unknown) => xmlFormatter.blocksToText!([b as never]);
const mdText = (b: unknown) => markdownFormatter.blocksToText!([b as never]);
const plainText = (b: unknown) => textFormatter.blocksToText!([b as never]);
const rendered = (fmt: typeof xmlFormatter, b: unknown) =>
  (fmt([b as SemanticContentBlock])[0] as { text: string }).text;

describe("metadata is the other side of the line", () => {
  it("never reaches the model — `data` is read, `metadata` is recorded", () => {
    // The split every producer relies on: retrieval keys and token accounting
    // ride the block so a projector can read them, and cost the model nothing.
    const withMeta = {
      ...compaction,
      metadata: {
        questions: ["How does Harbor View handle retainage?"],
        usage: { inputTokens: 40_000, outputTokens: 900, totalTokens: 40_900 },
      },
    };
    for (const render of [xmlText, mdText, plainText]) {
      const out = render(withMeta);
      expect(out).toBe(render(compaction));
      expect(out).not.toContain("retainage");
      expect(out).not.toContain("40000");
    }
  });
});

describe("the payload renders", () => {
  it("xml emits identifiers as attributes and the data bag as children", () => {
    expect(xmlText(compaction)).toBe(
      '<system_event event="compaction" source="timeline">\n' +
        "<summary>Discussed the store substrate.</summary>\n" +
        "<entriesBefore>42</entriesBefore>\n" +
        "</system_event>",
    );
  });

  it("a data-bearing event is never empty", () => {
    for (const render of [xmlText, mdText, plainText]) {
      expect(render(compaction)).toContain("Discussed the store substrate.");
    }
  });

  it("the render and collapse paths agree", () => {
    for (const fmt of [xmlFormatter, markdownFormatter, textFormatter]) {
      const collapse = fmt.blocksToText!([compaction as never]);
      expect(rendered(fmt, compaction)).toBe(collapse);
    }
  });

  it("non-scalar values serialize as JSON", () => {
    const block = { type: "system_event" as const, event: "e", data: { at: { tick: 3 } } };
    expect(xmlText(block)).toContain("<at>{&quot;tick&quot;:3}</at>");
  });
});

describe("text overrides the derived body", () => {
  const framed = { ...compaction, text: "The conversation was compacted." };

  it("replaces the children but keeps the identifiers", () => {
    expect(xmlText(framed)).toBe(
      '<system_event event="compaction" source="timeline">\n' +
        "The conversation was compacted.\n" +
        "</system_event>",
    );
  });

  it("an event with neither payload nor text is self-closing", () => {
    expect(xmlText({ type: "system_event" as const, event: "resumed" })).toBe(
      '<system_event event="resumed" />',
    );
  });
});

describe("each block keeps its own shape", () => {
  it("state_change renders the diff", () => {
    const block = {
      type: "state_change" as const,
      entity: "task",
      field: "status",
      from: "working",
      to: "completed",
    };
    expect(xmlText(block)).toBe(
      '<state_change entity="task" field="status">\n' +
        "<from>working</from>\n<to>completed</to>\n" +
        "</state_change>",
    );
  });

  it("user_action renders actor and details", () => {
    const block = {
      type: "user_action" as const,
      action: "navigate",
      actor: "ryan",
      details: { to: "/projects/19287" },
    };
    expect(xmlText(block)).toBe(
      '<user_action action="navigate" actor="ryan">\n' +
        "<to>/projects/19287</to>\n" +
        "</user_action>",
    );
  });

  it("absent optional identifiers do not render as empty attributes", () => {
    expect(xmlText({ type: "system_event" as const, event: "e", data: { a: "1" } })).toContain(
      '<system_event event="e">',
    );
  });
});

describe("escaping follows the dialect", () => {
  const angled = {
    type: "system_event" as const,
    event: 'quote"and<angle>',
    data: { note: "<b>bold</b>" },
  };

  it("xml escapes both attributes and content", () => {
    expect(xmlText(angled)).toBe(
      '<system_event event="quote&quot;and&lt;angle&gt;">\n' +
        "<note>&lt;b&gt;bold&lt;/b&gt;</note>\n" +
        "</system_event>",
    );
  });

  it("markdown escapes attributes but passes content through", () => {
    expect(mdText(angled)).toBe(
      '<system_event event="quote&quot;and&lt;angle&gt;">\n' +
        "<note><b>bold</b></note>\n" +
        "</system_event>",
    );
  });
});

describe("the text dialect uses no markup", () => {
  it("brackets the identifiers and lists the payload", () => {
    expect(plainText(compaction)).toBe(
      "[system_event event=compaction source=timeline]\n" +
        "summary: Discussed the store substrate.\n" +
        "entriesBefore: 42",
    );
  });

  it("an empty event is the bracket alone", () => {
    expect(plainText({ type: "system_event" as const, event: "resumed" })).toBe(
      "[system_event event=resumed]",
    );
  });
});
