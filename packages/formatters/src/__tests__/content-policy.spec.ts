/**
 * Content-reduction formatter tests — `textOnlyFormatter` /
 * `summarizedFormatter`. Pure input → output assertions over
 * `SemanticContentBlock[]`.
 */

import { describe, expect, it } from "vitest";

import type { SemanticContentBlock } from "@agentick/spec";
import {
  textOnlyFormatter,
  summarizedFormatter,
  createSummarizedFormatter,
  createToolSummarizer,
} from "../index.js";

function text(t: string): SemanticContentBlock {
  return { type: "text", text: t } as SemanticContentBlock;
}
function toolUse(name: string, input: Record<string, unknown>): SemanticContentBlock {
  return { type: "tool_use", toolUseId: `tu-${name}`, name, input } as SemanticContentBlock;
}
function toolResult(text: string): SemanticContentBlock {
  return {
    type: "tool_result",
    toolUseId: "tu",
    content: [{ type: "text", text }],
  } as unknown as SemanticContentBlock;
}

describe("textOnlyFormatter", () => {
  it("keeps text, drops tool_use and tool_result", () => {
    const out = textOnlyFormatter([
      text("hello"),
      toolUse("bash", { command: "ls" }),
      toolResult("file listing"),
      text("done"),
    ]);
    expect(out).toEqual([
      { type: "text", text: "hello" },
      { type: "text", text: "done" },
    ]);
  });

  it("keeps media blocks", () => {
    const img = {
      type: "image",
      source: { type: "url", url: "http://x/y.png" },
    } as SemanticContentBlock;
    const out = textOnlyFormatter([img, toolUse("read_file", { path: "a" })]);
    expect(out).toEqual([img]);
  });
});

describe("summarizedFormatter", () => {
  it("collapses tool_use into a short summary and drops tool_result", () => {
    const out = summarizedFormatter([
      text("working"),
      toolUse("bash", { command: "npm test" }),
      toolResult("all passed"),
    ]);
    expect(out).toEqual([
      { type: "text", text: "working" },
      { type: "text", text: "[Ran: npm test]" },
    ]);
  });

  it("summarizes known file tools", () => {
    const out = summarizedFormatter([toolUse("read_file", { path: "/etc/hosts" })]);
    expect(out).toEqual([{ type: "text", text: "[Read /etc/hosts]" }]);
  });

  it("falls back to a generic summary for unknown tools", () => {
    const out = summarizedFormatter([toolUse("teleport", { to: "mars" })]);
    expect(out).toEqual([{ type: "text", text: "[Used teleport]" }]);
  });
});

describe("createToolSummarizer / createSummarizedFormatter", () => {
  it("honors custom summaries", () => {
    const fmt = createSummarizedFormatter(
      createToolSummarizer({ deploy: (i) => `[Deploying to ${i.env}]` }),
    );
    const out = fmt([toolUse("deploy", { env: "prod" })]);
    expect(out).toEqual([{ type: "text", text: "[Deploying to prod]" }]);
  });
});
