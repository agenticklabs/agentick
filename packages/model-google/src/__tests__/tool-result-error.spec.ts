/**
 * A failed tool call must not reach the model as a successful one.
 *
 * `isError` was dropped from the `functionResponse` projection and an empty result
 * was filled in with the literal `"Done"` — so a tool that threw arrived as
 * `{ result: "Done" }`. Not merely uninformative: affirmatively false.
 *
 * Observed live before this was fixed. `resource_read` failed, Gemini was told
 * "Done", retried the identical uri, failed again, and then told the user the tool
 * "is not returning the expected content, only a 'Done' status" — the model
 * diagnosing the adapter, because the adapter had lied to it. Two wasted calls and a
 * dead end, from one word.
 *
 * The word itself is fine where it is true: a successful void tool (navigate,
 * dismiss) did its work and has nothing to say. The defect was using one word for
 * both outcomes.
 */

import { describe, expect, it } from "vitest";
import type { GenerateContentParameters } from "@google/genai";
import type { ContentBlock } from "@agentick/spec";

import { StubGoogleClient, mkResponse, mkTarget } from "../testing/index.js";
import { makeExecutor } from "./executor-harness.js";

/** The `functionResponse.response` the adapter sent for the first tool result. */
function sentToolResponse(params: GenerateContentParameters): Record<string, unknown> | undefined {
  const contents = params.contents as ReadonlyArray<{
    readonly parts?: ReadonlyArray<{
      readonly functionResponse?: { readonly response?: Record<string, unknown> };
    }>;
  }>;
  for (const content of contents) {
    for (const part of content.parts ?? []) {
      if (part.functionResponse) return part.functionResponse.response;
    }
  }
  return undefined;
}

/**
 * A tree carrying one assistant tool call and its result — the shape a second tick
 * projects after a dispatch.
 */
function treeWithToolResult(opts: { isError?: boolean; text?: string }) {
  const content: ContentBlock[] = [
    {
      type: "tool_result",
      toolUseId: "call_1",
      name: "resource_read",
      content: opts.text === undefined ? [] : [{ type: "text", text: opts.text }],
      ...(opts.isError === true ? { isError: true } : {}),
    } as ContentBlock,
  ];
  return {
    specVersion: "2026-05-08",
    context: {
      entries: [
        { kind: "message", id: "m_1", role: "user", content: [{ type: "text", text: "who am i" }] },
        {
          kind: "message",
          id: "m_2",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              toolUseId: "call_1",
              name: "resource_read",
              input: { uri: "knowify://me" },
            },
          ],
        },
        { kind: "message", id: "m_3", role: "tool", content },
      ],
    },
  } as never;
}

async function project(tree: never) {
  const stub = new StubGoogleClient([
    { kind: "non-streaming", response: mkResponse({ text: "ok" }) },
  ]);
  const { exec } = await makeExecutor(stub);
  await exec.run({ compiled: tree, target: mkTarget(), tools: [] });
  return sentToolResponse(stub.calls[0]!.params);
}

describe("google() adapter — a failed tool result says so", () => {
  it("projects `error`, NOT `result: Done`, when the dispatch failed", async () => {
    const response = await project(
      treeWithToolResult({ isError: true, text: "resource knowify://me not found" }),
    );
    expect(response).toEqual({ error: "resource knowify://me not found" });
  });

  it("still says it failed when the failure carried no message", async () => {
    // An empty `error` would leave the model guessing, which is how it ends up
    // retrying the same call.
    const response = await project(treeWithToolResult({ isError: true }));
    expect(response?.["error"]).toBeTypeOf("string");
    expect(String(response?.["error"]).length).toBeGreaterThan(0);
    expect(response).not.toHaveProperty("result");
  });

  it("keeps `Done` for a SUCCESSFUL call that returned nothing", async () => {
    // Where the word is true: a void tool did its work and has nothing to say.
    const response = await project(treeWithToolResult({}));
    expect(response).toEqual({ result: "Done" });
  });

  it("passes a successful result's text through unchanged", async () => {
    const response = await project(treeWithToolResult({ text: "# Current User\n\nMike Mock" }));
    expect(response).toEqual({ result: "# Current User\n\nMike Mock" });
  });
});
