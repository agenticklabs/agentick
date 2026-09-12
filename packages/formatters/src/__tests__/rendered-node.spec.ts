/**
 * A `rendered` semantic node holds a collected subtree. The dialect that holds
 * the node lowers the subtree's entries (islands in theirs), frames them as a
 * document, and composes the bytes verbatim into whatever surrounds the node.
 */

import { describe, expect, it } from "vitest";

import type {
  ContentBlock,
  FormatterResolver,
  MessageEntry,
  RenderedTree,
  SemanticContentBlock,
  SemanticNode,
} from "@agentick/spec";
import * as blocks from "@agentick/spec/blocks";

import { markdownFormatter, xmlFormatter } from "../index.js";

const semantic = (node: SemanticNode): SemanticContentBlock =>
  ({ type: "text", text: "", semanticNode: node }) as SemanticContentBlock;

const message = (role: MessageEntry["role"], content: ContentBlock[], extra = {}): MessageEntry =>
  ({ kind: "message", role, content, ...extra }) as MessageEntry;

const tree = (entries: MessageEntry[]): RenderedTree =>
  ({ specVersion: "test", context: { entries } }) as unknown as RenderedTree;

const rendered = (t: RenderedTree): SemanticNode => ({ semantic: "rendered", tree: t });

const frame = (children: SemanticNode[]): SemanticNode => ({
  semantic: "custom",
  props: { tag: "past-conversation", attrs: { session: "s1" } },
  children,
});

const resolve: FormatterResolver = (ref) =>
  ref.format === "markdown" ? markdownFormatter : ref.format === "xml" ? xmlFormatter : undefined;

describe("rendered node — xml", () => {
  it("frames the subtree's entries inside the element that holds it", () => {
    const [out] = xmlFormatter([
      semantic(frame([rendered(tree([message("user", [blocks.text("hi & <bye>")])]))])),
    ]);
    expect((out as { text: string }).text).toBe(
      '<past-conversation session="s1">\n<message role="user">\nhi &amp; &lt;bye&gt;\n</message>\n</past-conversation>',
    );
  });

  it("lowers an entry that declared another dialect in that dialect", () => {
    const heading: SemanticContentBlock = semantic({
      semantic: "heading",
      props: { level: 1 },
      children: [{ text: "Title" }],
    });
    const island = message("user", [heading as ContentBlock], {
      renderedWith: { id: "formatter.markdown", format: "markdown" },
    });
    const [out] = xmlFormatter([semantic(frame([rendered(tree([island]))]))], resolve);
    expect((out as { text: string }).text).toContain("# Title");
    expect((out as { text: string }).text).not.toContain("<h1>");
  });

  it("writes tool calls and their results in the subtree", () => {
    const entries = [
      message("assistant", [blocks.toolUse("c1", "query", { a: 1 }) as ContentBlock]),
      message("user", [
        {
          type: "tool_result",
          toolUseId: "c1",
          name: "query",
          content: [blocks.text("3 rows")],
        } as ContentBlock,
      ]),
    ];
    const [out] = xmlFormatter([semantic(rendered(tree(entries)))]);
    expect((out as { text: string }).text).toBe(
      [
        '<message role="assistant">',
        '<tool_use id="c1" name="query">{"a":1}</tool_use>',
        "</message>",
        "",
        '<message role="user">',
        '<tool_result id="c1" name="query">3 rows</tool_result>',
        "</message>",
      ].join("\n"),
    );
  });

  it("flattens a rendered node nested in a tool result's content", () => {
    const result: ContentBlock = {
      type: "tool_result",
      toolUseId: "c1",
      name: "fetch_history",
      content: [semantic(frame([rendered(tree([message("user", [blocks.text("hi")])]))]))],
    };
    const [out] = xmlFormatter([result as SemanticContentBlock]);
    expect(out.type).toBe("tool_result");
    const inner = (out as unknown as { content: ContentBlock[] }).content[0] as {
      text: string;
      semanticNode?: unknown;
    };
    expect(inner.semanticNode).toBeUndefined();
    expect(inner.text).toBe(
      '<past-conversation session="s1">\n<message role="user">\nhi\n</message>\n</past-conversation>',
    );
  });
});

describe("rendered node — markdown", () => {
  it("embeds the framed subtree verbatim", () => {
    const [out] = markdownFormatter([
      semantic(frame([rendered(tree([message("user", [blocks.text("hi *there*")])]))])),
    ]);
    const text = (out as { text: string }).text;
    expect(text).toContain('<past-conversation session="s1">');
    expect(text).toContain("hi *there*");
    expect(text).toContain("</past-conversation>");
  });

  it("flattens a rendered node nested in a tool result's content", () => {
    const result: ContentBlock = {
      type: "tool_result",
      toolUseId: "c1",
      name: "fetch_history",
      content: [semantic(rendered(tree([message("user", [blocks.text("hi")])])))],
    };
    const [out] = markdownFormatter([result as SemanticContentBlock]);
    const inner = (out as unknown as { content: ContentBlock[] }).content[0] as {
      text: string;
      semanticNode?: unknown;
    };
    expect(inner.semanticNode).toBeUndefined();
    expect(inner.text).toContain("hi");
  });
});
