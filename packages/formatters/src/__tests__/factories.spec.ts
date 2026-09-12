/** ADR 111 §factories: configured built-ins are values, registered by id; the dialect stays theirs. */

import { describe, expect, it } from "vitest";

import type { SemanticContentBlock, SemanticNode } from "@agentick/spec";
import { json as jsonBlock, text as textBlock } from "@agentick/spec/blocks";

import {
  createMarkdownFormatter,
  createXmlFormatter,
  formatters,
  markdownFormatter,
  xmlFormatter,
} from "../index.js";

const semantic = (node: SemanticNode): SemanticContentBlock =>
  ({ type: "text", text: "", semanticNode: node }) as SemanticContentBlock;
const tree = semantic({
  semantic: "custom",
  props: { tag: "message-metadata", attrs: { seq: "3" } },
  children: [{ semantic: "custom", props: { tag: "path" }, children: [{ text: "/x" }] }],
} as SemanticNode);
const textOf = (f: typeof xmlFormatter, b: SemanticContentBlock) =>
  (f([b])[0] as { text: string }).text;

describe("createXmlFormatter", () => {
  it("is the default under the default id, and a configured one under its own", () => {
    expect(createXmlFormatter().__identity).toEqual(xmlFormatter.__identity);
    expect(createXmlFormatter({ id: "xml.compact", version: "2" }).__identity).toEqual({
      id: "xml.compact",
      format: "xml",
      version: "2",
    });
  });

  it("passes builder options through: format off flattens the element tree, indentBy changes the indent", () => {
    expect(textOf(xmlFormatter, tree)).toBe(
      '<message-metadata seq="3">\n  <path>/x</path>\n</message-metadata>',
    );
    expect(textOf(createXmlFormatter({ builder: { format: false } }), tree)).toBe(
      '<message-metadata seq="3"><path>/x</path></message-metadata>',
    );
    expect(textOf(createXmlFormatter({ builder: { indentBy: "\t" } }), tree)).toBe(
      '<message-metadata seq="3">\n\t<path>/x</path>\n</message-metadata>',
    );
  });

  it("keeps escaping and order its own whatever the builder options say", () => {
    const f = createXmlFormatter({
      builder: { processEntities: true, ignoreAttributes: true } as never,
    });
    expect(textOf(f, textBlock('a < b & "c"') as SemanticContentBlock)).toBe('a &lt; b &amp; "c"');
    expect(textOf(f, tree)).toContain('seq="3"');
  });

  it("lets one block type be rendered differently and leaves the rest to the dialect", () => {
    const f = createXmlFormatter({
      blocks: {
        json: (b) => ({
          type: "text",
          text: `<data>${JSON.stringify((b as { data: unknown }).data)}</data>`,
        }),
      },
    });
    expect(textOf(f, jsonBlock({ a: 1 }) as SemanticContentBlock)).toBe('<data>{"a":1}</data>');
    expect(textOf(f, { type: "code", text: "x" } as SemanticContentBlock)).toBe("<code>x</code>");
    const fallsBack = createXmlFormatter({ blocks: { code: () => undefined } });
    expect(textOf(fallsBack, { type: "code", text: "x" } as SemanticContentBlock)).toBe(
      "<code>x</code>",
    );
  });
});

describe("createMarkdownFormatter", () => {
  const list = semantic({
    semantic: "list",
    children: [
      { semantic: "list-item", children: [{ text: "a" }] },
      { semantic: "list-item", children: [{ text: "b" }] },
    ],
  } as SemanticNode);

  it("passes layout options through, merged over the dialect's", () => {
    expect(textOf(markdownFormatter, list)).toBe("- a\n- b");
    expect(textOf(createMarkdownFormatter({ layout: { bullet: "*" } }), list)).toBe("* a\n* b");
  });

  it("a layout handler override reaches the library: text escaping can be turned on", () => {
    const escaping = createMarkdownFormatter({
      layout: { handlers: { text: (node, _p, state, info) => state.safe(node.value, info) } },
    });
    const prose = semantic({
      semantic: "paragraph",
      children: [{ text: "a * b and user_id" }],
    } as SemanticNode);
    expect(textOf(markdownFormatter, prose)).toBe("a * b and user_id");
    expect(textOf(escaping, prose)).toBe("a \\* b and user\\_id");
  });

  it("lets one block type be rendered differently", () => {
    const f = createMarkdownFormatter({
      blocks: {
        json: (b) => ({ type: "text", text: JSON.stringify((b as { data: unknown }).data) }),
      },
    });
    expect(textOf(f, jsonBlock({ a: 1 }) as SemanticContentBlock)).toBe('{"a":1}');
  });
});

describe("formatters()", () => {
  it("builds the registry by id, so two configurations coexist", () => {
    const registry = formatters([
      xmlFormatter,
      createXmlFormatter({ id: "xml.compact", builder: { format: false } }),
    ]);
    expect([...registry.keys()]).toEqual(["formatter.xml", "xml.compact"]);
    expect(registry.get("xml.compact")!.__identity.format).toBe("xml");
  });
});
