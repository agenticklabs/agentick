/**
 * ADR 111 parity: one rich fixture through the markdown dialect, snapshotted on
 * the string-template formatter BEFORE the port. The diff after is the review.
 */

import { describe, expect, it } from "vitest";

import type { ContentBlock, SemanticContentBlock, SemanticNode } from "@agentick/spec";

import { markdownFormatter } from "../markdown.js";

const semantic = (node: SemanticNode): SemanticContentBlock =>
  ({ type: "text", text: "", semanticNode: node }) as SemanticContentBlock;
const t = (text: string): SemanticNode => ({ text });
const s = (
  semantic: string,
  children: SemanticNode[],
  props?: Record<string, unknown>,
): SemanticNode => ({ semantic, children, ...(props ? { props } : {}) }) as SemanticNode;

const FIXTURE: SemanticContentBlock[] = [
  {
    type: "text",
    text: 'plain & "quoted" <text> with *stars* and user_id',
  } as SemanticContentBlock,
  semantic(
    s("paragraph", [
      t("a "),
      s("strong", [t("b")]),
      t(" c "),
      s("em", [t("d")]),
      t("\nline two with a * star and user_id"),
    ]),
  ),
  semantic(s("heading", [t("Hi & bye")], { level: 3 })),
  semantic(
    s(
      "list",
      [
        s("list-item", [t("one")]),
        s("list-item", [
          t("two "),
          s("code", [t("x<y")]),
          s("list", [s("list-item", [t("nested")])]),
        ]),
      ],
      { ordered: true },
    ),
  ),
  semantic(s("list", [s("list-item", [t("bullet")])])),
  semantic(
    s("table", [
      s("row", [s("cell", [t("h1")]), s("cell", [t("h2")])]),
      s("row", [s("cell", [t("1")]), s("cell", [t("2")])]),
    ]),
  ),
  semantic(s("blockquote", [t("quoted\nsecond line")])),
  semantic(s("link", [t("site")], { href: "https://x.test/?a=1&b=2" })),
  semantic(s("image", [], { src: "https://x.test/i.png", alt: 'an "alt"' })),
  semantic(s("line-break", [])),
  semantic(s("horizontal-rule", [])),
  semantic(s("block", [t("div")])),
  semantic(s("inline", [t("span")])),
  semantic(s("mark", [t("marked")])),
  semantic(s("underline", [t("under")])),
  semantic(s("strikethrough", [t("struck")])),
  semantic(s("keyboard", [t("Ctrl")])),
  semantic(s("quote", [t("q")])),
  semantic(s("citation", [t("cite")])),
  semantic(s("preformatted", [t("pre <x>")])),
  semantic(
    s(
      "custom",
      [
        s("custom", [t("/#/jobs/1042?a=1&b=2")], { tag: "path" }),
        s("custom", [t("client, title")], { tag: "unchanged" }),
      ],
      { tag: "message-metadata", attrs: { seq: "3" } },
    ),
  ),
  semantic(s("custom", [t("inline *custom*")], { tag: "note-inline", attrs: { kind: 'x "q"' } })),
  semantic(s("custom", [], { tag: "file-ref", attrs: { id: "f1" }, selfClosing: true })),
  { type: "reasoning", text: "think <hard>" } as SemanticContentBlock,
  { type: "code", language: "ts", text: "const a = b < c && d;" } as SemanticContentBlock,
  { type: "json", data: { a: "<b>", c: 'd"e' } } as SemanticContentBlock,
  { type: "csv", text: 'a,b\n1,"2,3"' } as SemanticContentBlock,
  { type: "xml", text: "<raw>island</raw>" } as SemanticContentBlock,
  {
    type: "user_action",
    action: "click",
    actor: "mike",
    details: { x: 1, y: "<2>" },
  } as SemanticContentBlock,
  {
    type: "system_event",
    event: "compaction",
    source: "loop",
    text: "summary & more",
  } as SemanticContentBlock,
  {
    type: "state_change",
    entity: "job",
    field: "status",
    from: "open",
    to: "closed",
  } as SemanticContentBlock,
  {
    type: "custom",
    tag: "memory-kind",
    content: "episodic & <recall> *md*",
    attrs: { kind: "episodic" },
  } as SemanticContentBlock,
  { type: "custom", tag: "empty-one", content: "", selfClosing: true } as SemanticContentBlock,
];

const TREE_LEVEL: ContentBlock[] = [
  {
    type: "image",
    source: { type: "url", url: "https://x.test/i.png?a=1&b=2" },
    altText: 'alt "q"',
  } as ContentBlock,
  {
    type: "document",
    source: { type: "base64", data: "AAA", mimeType: "application/pdf" },
  } as ContentBlock,
  {
    type: "tool_use",
    toolUseId: "c1",
    name: "query",
    input: { model: "Jobs", where: { a: "<b>" } },
  } as ContentBlock,
  {
    type: "tool_result",
    toolUseId: "c1",
    name: "query",
    content: [{ type: "text", text: "3 rows & <more>" }],
  } as ContentBlock,
];

describe("markdown dialect — parity fixture", () => {
  it("block pass", () => {
    expect(
      markdownFormatter(FIXTURE).map((b) => (b as { text?: string }).text ?? `[${b.type}]`),
    ).toMatchSnapshot();
  });

  it("tree level: blocksToText and frameMessage", () => {
    const body = markdownFormatter.blocksToText!([...markdownFormatter(FIXTURE), ...TREE_LEVEL]);
    expect(
      markdownFormatter.frameMessage!({ role: "user", content: [] } as never, body),
    ).toMatchSnapshot();
  });
});

describe("markdown dialect — a stored tool block without an id", () => {
  it("renders the frame without the id", () => {
    const blocks = [
      { type: "tool_use", name: "query", input: {} },
      { type: "tool_result", name: "query", content: [{ type: "text", text: "ok" }] },
    ] as unknown as ContentBlock[];
    expect(markdownFormatter.blocksToText!(blocks)).toBe(
      "[tool_use query] {}\n\n[tool_result query] ok",
    );
  });
});
