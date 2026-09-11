import React from "react";
import { describe, expect, it } from "vitest";

import type { ContentBlock, ToolResultBlock } from "@agentick/spec";

import { Formatted, Message, Text, ToolResult, XML, compileTemplate } from "../index.js";

const first = async (element: React.ReactNode): Promise<ToolResultBlock> => {
  const { tree } = await compileTemplate(element);
  const [block] = tree.context.entries[0]!.content;
  if (block?.type !== "tool_result") throw new Error(`expected tool_result, got ${block?.type}`);
  return block;
};

describe("<ToolResult>", () => {
  it("folds its children into content", async () => {
    const block = await first(
      <Message role="user">
        <ToolResult toolUseId="c1" name="query">
          <Text text="3 rows" />
        </ToolResult>
      </Message>,
    );
    expect(block.toolUseId).toBe("c1");
    expect(block.name).toBe("query");
    expect(block.content).toEqual([{ type: "text", text: "3 rows" }]);
  });

  it("takes the content prop verbatim when it has no children", async () => {
    const content: ContentBlock[] = [{ type: "json", data: { rows: 3 } }];
    const block = await first(
      <Message role="user">
        <ToolResult toolUseId="c1" name="query" isError content={content} />
      </Message>,
    );
    expect(block.content).toEqual(content);
    expect(block.isError).toBe(true);
    expect("children" in block).toBe(false);
  });

  it("carries a formatted past conversation as its text", async () => {
    const block = await first(
      <XML>
        <Message role="user">
          <ToolResult toolUseId="c1" name="fetch_history">
            <past-conversation session="s1" from-seq="1" to-seq="2">
              <Formatted>
                <Message role="user">hi</Message>
                <Message role="assistant">hello</Message>
              </Formatted>
            </past-conversation>
          </ToolResult>
        </Message>
      </XML>,
    );
    expect(block.content).toEqual([
      {
        type: "text",
        text: [
          '<past-conversation session="s1" from-seq="1" to-seq="2">',
          '<message role="user">',
          "hi",
          "</message>",
          "",
          '<message role="assistant">',
          "hello",
          "</message>",
          "</past-conversation>",
        ].join("\n"),
      },
    ]);
  });

  it("warns and emits nothing without a tool use id", async () => {
    const { tree, diagnostics } = await compileTemplate(
      <Message role="user">
        <tool_result toolUseId="" name="query" />
      </Message>,
    );
    expect(tree.context.entries[0]!.content).toEqual([]);
    expect(diagnostics.some((d) => d.code === "MISSING_TOOL_USE_ID")).toBe(true);
  });
});
