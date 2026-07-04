/**
 * `generate()` / `generateStream()` — standalone single-shot fold
 * against a scripted adapter. No harness, no substrate.
 */

import { describe, expect, it } from "vitest";

import { generate, generateStream } from "../generate.js";
import { scriptedAdapter } from "../testing/index.js";
import type { LanguageModelAdapter } from "../language-model-adapter.js";

interface ScriptedRaw {
  readonly text: string;
}
type ScriptedChunk = string;

describe("generate()", () => {
  it("runs buildParams → call → normalize and returns the result", async () => {
    const result = await generate({
      model: scriptedAdapter(["hello ", "world"].join(""), { chunks: ["hello ", "world"] }),
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(result.output[0]).toMatchObject({ type: "text", text: "hello world" });
    expect(result.stopReason).toBe("end");
  });

  it("applies postProcessForNormalize when the adapter declares it", async () => {
    const adapter = scriptedAdapter(["raw"].join(""), { chunks: ["raw"] });
    const withPost: LanguageModelAdapter<ScriptedRaw, ScriptedChunk> = {
      ...adapter,
      postProcessForNormalize: (raw) => ({ text: raw.text.toUpperCase() }),
    };
    const result = await generate({
      model: withPost,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(result.output[0]).toMatchObject({ type: "text", text: "RAW" });
  });
});

describe("generateStream()", () => {
  it("yields the canonical delta vocabulary and resolves the result", async () => {
    const handle = generateStream({
      model: scriptedAdapter(["hel", "lo"].join(""), { chunks: ["hel", "lo"] }),
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    const types: string[] = [];
    let text = "";
    for await (const delta of handle.stream) {
      types.push(delta.type);
      if (delta.type === "content-delta") text += delta.delta;
    }
    // Synthetic message-start injected before the first delta; default
    // finalize closes the block and emits message-end + message summary.
    expect(types[0]).toBe("message-start");
    expect(types).toContain("content-start");
    expect(types).toContain("content-end");
    expect(types).toContain("message-end");
    expect(types[types.length - 1]).toBe("message");
    expect(text).toBe("hello");

    const result = await handle.result;
    expect(result.output[0]).toMatchObject({ type: "text", text: "hello" });
  });

  it("runs the adapter's transform pipeline (think tags → reasoning)", async () => {
    const handle = generateStream({
      model: scriptedAdapter(["<think>plan</think>", "answer"].join(""), {
        chunks: ["<think>plan</think>", "answer"],
        thinkTags: true,
      }),
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    let reasoning = "";
    let text = "";
    for await (const delta of handle.stream) {
      if (delta.type === "reasoning-delta") reasoning += delta.delta;
      if (delta.type === "content-delta") text += delta.delta;
    }
    expect(reasoning).toBe("plan");
    expect(text).toBe("answer");
  });

  it("rejects the result when the provider stream throws", async () => {
    const adapter = scriptedAdapter(["x"].join(""), { chunks: ["x"] });
    const failing: LanguageModelAdapter<ScriptedRaw, ScriptedChunk> = {
      ...adapter,
      openStream: () => {
        throw new Error("provider down");
      },
    };
    const handle = generateStream({
      model: failing,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    await expect(async () => {
      for await (const _ of handle.stream) void _;
    }).rejects.toThrow("provider down");
    await expect(handle.result).rejects.toThrow("provider down");
  });
});
