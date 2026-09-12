import React from "react";
import { describe, expect, it } from "vitest";

import type { ContentBlock } from "@agentick/spec";
import * as blocks from "@agentick/spec/blocks";

import { Formatted, Markdown, Message, XML, compileTemplate, renderTemplate } from "../index.js";

const toolUse: ContentBlock = blocks.toolUse("c1", "query", { a: 1 });
const toolResult: ContentBlock = {
  type: "tool_result",
  toolUseId: "c1",
  name: "query",
  content: [blocks.text("3 rows")],
};

describe("<Formatted>", () => {
  it("renders its messages as one framed string inside the element that holds it", async () => {
    const { output } = await renderTemplate(
      <XML>
        <Message role="user">
          <past-conversation session="s1">
            <Formatted>
              <Message role="user">hi & bye</Message>
              <Message role="assistant" content={[toolUse]} />
              <Message role="user" content={[toolResult]} />
            </Formatted>
          </past-conversation>
        </Message>
      </XML>,
    );
    expect(output).toContain(
      [
        '<past-conversation session="s1">',
        '<message role="user">',
        "hi &amp; bye",
        "</message>",
        "",
        '<message role="assistant">',
        '<tool_use id="c1" name="query">{"a":1}</tool_use>',
        "</message>",
        "",
        '<message role="user">',
        '<tool_result id="c1" name="query">3 rows</tool_result>',
        "</message>",
        "</past-conversation>",
      ].join("\n"),
    );
  });

  it("is text to the prompt — the messages inside are not entries", async () => {
    const { tree } = await compileTemplate(
      <XML>
        <Message role="user">
          <Formatted>
            <Message role="user">hi</Message>
            <Message role="assistant">hello</Message>
          </Formatted>
        </Message>
      </XML>,
    );
    expect(tree.context.entries).toHaveLength(1);
    const [block] = tree.context.entries[0]!.content;
    expect(block!.type).toBe("text");
    expect((block as { text: string }).text).toContain('<message role="assistant">');
  });

  it("keeps an inner dialect for the entries that declared it", async () => {
    const { output } = await renderTemplate(
      <XML>
        <Message role="user">
          <Formatted>
            <Markdown>
              <Message role="user">
                <h1>Title</h1>
              </Message>
            </Markdown>
          </Formatted>
        </Message>
      </XML>,
    );
    expect(output).toContain("# Title");
    expect(output).not.toContain("<h1>");
  });

  it("renders loose content as the document's free root", async () => {
    const { output } = await renderTemplate(
      <XML>
        <Message role="user">
          <Formatted>
            <p>just a paragraph</p>
          </Formatted>
        </Message>
      </XML>,
    );
    expect(output).toContain("<p>just a paragraph</p>");
  });

  it("emits nothing when empty", async () => {
    const { tree } = await compileTemplate(
      <XML>
        <Message role="user">
          <Formatted />
        </Message>
      </XML>,
    );
    expect(tree.context.entries[0]!.content).toEqual([]);
  });
});
