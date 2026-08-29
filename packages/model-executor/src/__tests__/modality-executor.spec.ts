/**
 * The image-model + embedding-model families (ADR 105): the call is a command
 * — it returns the adapter's result, its guard-bag key vetoes it, and a raw
 * provider throw arrives as the typed ExecuteErrorChannel.
 */

import { describe, expect, it } from "vitest";
import type { EmbeddingModelAdapter, ImageModelAdapter } from "@agentick/spec";
import { SPEC_VERSION, isExecuteError } from "@agentick/spec";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";

import { EmbeddingModelExecutor, ImageModelExecutor } from "../modality-executor.js";

const PNG = "iVBORw0KGgo=";

function imageAdapter(calls: unknown[] = []): ImageModelAdapter {
  return {
    provider: "stub",
    target: { kind: "image-model", provider: "stub", modelId: "img-1" },
    async generate(input) {
      calls.push(input);
      return {
        specVersion: SPEC_VERSION,
        output: [{ type: "image", source: { type: "base64", data: PNG, mimeType: "image/png" } }],
        images: [{ data: PNG, mimeType: "image/png" }],
      };
    },
  };
}

function embeddingAdapter(): EmbeddingModelAdapter {
  return {
    provider: "stub",
    target: { kind: "embedding-model", provider: "stub", modelId: "emb-1" },
    async embed(input) {
      return {
        specVersion: SPEC_VERSION,
        output: [],
        embeddings: input.input.map((_, i) => [i, i + 0.5]),
        dimensions: 2,
      };
    },
  };
}

function substrate() {
  return { journal: new MemoryJournal(), bus: new LocalEventBus(), inbox: new LocalInbox() };
}

describe("ImageModelExecutor", () => {
  it("generate runs the adapter through the model:generate_image command", async () => {
    const { journal, bus, inbox } = substrate();
    const calls: unknown[] = [];
    const exec = new ImageModelExecutor("t:images", journal, bus, inbox, {
      adapter: imageAdapter(calls),
    });
    await exec.ready;

    const result = await exec.generate({ prompt: "a red door", count: 2 });

    expect(result.images).toHaveLength(1);
    expect(result.output[0]).toMatchObject({ type: "image" });
    expect(calls[0]).toMatchObject({ prompt: "a red door", count: 2 });
    expect(exec.family).toBe("image-model");
    expect(exec.target.modelId).toBe("img-1");
  });

  it("the guard-bag key vetoes the call before the adapter runs — the policy seam", async () => {
    const { journal, bus, inbox } = substrate();
    const calls: unknown[] = [];
    const exec = new ImageModelExecutor("t:images", journal, bus, inbox, {
      adapter: imageAdapter(calls),
    });
    await exec.ready;
    exec.guard({
      modelGenerateImage: (call) =>
        /nsfw/i.test(call.input.prompt) ? { kind: "veto", reason: "content policy" } : undefined,
    });

    await expect(exec.generate({ prompt: "nsfw thing" })).rejects.toThrow("vetoed");
    expect(calls).toHaveLength(0);
  });

  it("a raw provider throw surfaces as the typed ExecuteErrorChannel", async () => {
    const { journal, bus, inbox } = substrate();
    const exec = new ImageModelExecutor("t:images", journal, bus, inbox, {
      adapter: {
        ...imageAdapter(),
        generate: async () => {
          throw new Error("quota exceeded");
        },
      },
    });
    await exec.ready;

    const err = await exec.generate({ prompt: "x" }).catch((e: unknown) => e);
    // The default mapper files an untyped throw as StreamFailed — a member of
    // the channel, so every consumer's `isExecuteError` narrowing holds.
    expect(isExecuteError(err)).toBe(true);
    expect((err as { _tag: string })._tag).toBe("StreamFailed");
  });
});

describe("EmbeddingModelExecutor", () => {
  it("embed returns one vector per input through the model:embed command", async () => {
    const { journal, bus, inbox } = substrate();
    const exec = new EmbeddingModelExecutor("t:emb", journal, bus, inbox, {
      adapter: embeddingAdapter(),
    });
    await exec.ready;

    const result = await exec.embed({ input: ["a", "b", "c"] });

    expect(result.embeddings).toEqual([
      [0, 0.5],
      [1, 1.5],
      [2, 2.5],
    ]);
    expect(result.dimensions).toBe(2);
    expect(exec.family).toBe("embedding-model");
  });
});
