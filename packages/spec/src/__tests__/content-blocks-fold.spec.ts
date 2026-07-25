/**
 * The `ContentBlock` exhaustive fold — the safety net against silently
 * dropping a new block type at the ~30 scattered `switch (block.type)` sites.
 *
 * The load-bearing assertion is the `@ts-expect-error` in "exhaustiveness is
 * enforced": an incomplete fold MUST be a compile error. If someone widens
 * `BlockType` and this test's exhaustive fold still compiled, the safety net
 * would be broken — the `@ts-expect-error` guarantees a missing handler fails
 * the build (so a `BlockType` addition is a guided compile sweep, not a silent
 * drop). This spec typechecks under the strict `tsconfig.json` gate.
 */

import { describe, expect, it } from "vitest";

import { foldContentBlock, foldContentBlockWith } from "../data/content-blocks.js";
import type { ContentBlock, ContentBlockFold } from "../data/content-blocks.js";

const text: ContentBlock = { type: "text", text: "hi" } as ContentBlock;
const resource: ContentBlock = {
  type: "resource",
  resource: { uri: "config://app", mimeType: "application/json", text: "{}" },
} as ContentBlock;

/** A total fold to the discriminant string — one handler per BlockType. */
const toType: ContentBlockFold<string> = {
  text: () => "text",
  reasoning: () => "reasoning",
  image: () => "image",
  document: () => "document",
  audio: () => "audio",
  video: () => "video",
  tool_use: () => "tool_use",
  tool_result: () => "tool_result",
  task_ref: () => "task_ref",
  resource: () => "resource",
  json: () => "json",
  xml: () => "xml",
  csv: () => "csv",
  html: () => "html",
  code: () => "code",
  generated_image: () => "generated_image",
  generated_file: () => "generated_file",
  executable_code: () => "executable_code",
  code_execution_result: () => "code_execution_result",
  user_action: () => "user_action",
  system_event: () => "system_event",
  state_change: () => "state_change",
  custom: () => "custom",
};

describe("foldContentBlock — exhaustive dispatch", () => {
  it("dispatches to the handler for the block's discriminant", () => {
    expect(foldContentBlock(text, toType)).toBe("text");
    expect(foldContentBlock(resource, toType)).toBe("resource");
  });

  it("exhaustiveness is enforced — an incomplete fold is a compile error", () => {
    // @ts-expect-error — missing handlers for every BlockType except `text`.
    // THIS is the safety net: if a fold could omit keys and still compile, a
    // new BlockType would be silently unhandled. The error proves it can't.
    const incomplete: ContentBlockFold<string> = { text: () => "text" };
    void incomplete;
    expect(true).toBe(true);
  });
});

describe("foldContentBlockWith — explicit fallback", () => {
  it("uses a matching handler when present", () => {
    const r = foldContentBlockWith(text, { text: () => "matched" }, () => "fallback");
    expect(r).toBe("matched");
  });

  it("routes unhandled types to the EXPLICIT fallback (a conscious ignore)", () => {
    const r = foldContentBlockWith(resource, { text: () => "matched" }, () => "fallback");
    expect(r).toBe("fallback");
  });
});
