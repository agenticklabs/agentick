import { describe, it, expect } from "vitest";
import {
  createEmbeddingAdapter,
  isEmbeddingModel,
  type EmbeddingModel,
  type EmbeddingMetadata,
} from "../embedding.js";
// import type { EmbedResult } from "@agentick/shared";

// ============================================================================
// Helpers
// ============================================================================

function mockMetadata(overrides: Partial<EmbeddingMetadata> = {}): EmbeddingMetadata {
  return {
    id: "test-embedder",
    provider: "test",
    dimensions: 128,
    ...overrides,
  };
}

function createMockAdapter(): EmbeddingModel {
  return createEmbeddingAdapter<{ texts: string[] }, { vecs: number[][] }>({
    metadata: mockMetadata(),
    prepareInput: (texts) => ({ texts }),
    execute: async (input) => ({
      vecs: input.texts.map((t) =>
        Array.from({ length: 128 }, (_, i) => t.charCodeAt(i % t.length) / 255),
      ),
    }),
    processOutput: (output) => ({
      embeddings: output.vecs,
      dimensions: 128,
      model: "test-model",
    }),
  });
}

// ============================================================================
// createEmbeddingAdapter
// ============================================================================

describe("createEmbeddingAdapter", () => {
  it("returns an object with metadata and embed function", () => {
    const adapter = createMockAdapter();
    expect(adapter.metadata).toBeDefined();
    expect(adapter.metadata.id).toBe("test-embedder");
    expect(adapter.metadata.provider).toBe("test");
    expect(adapter.metadata.dimensions).toBe(128);
    expect(typeof adapter.embed).toBe("function");
  });

  it("embed produces correct embeddings", async () => {
    const adapter = createMockAdapter();
    const result = await adapter.embed(["hello", "world"]);

    expect(result.embeddings).toHaveLength(2);
    expect(result.embeddings[0]).toHaveLength(128);
    expect(result.embeddings[1]).toHaveLength(128);
    expect(result.dimensions).toBe(128);
    expect(result.model).toBe("test-model");
  });

  it("embed with single text", async () => {
    const adapter = createMockAdapter();
    const result = await adapter.embed(["single"]);
    expect(result.embeddings).toHaveLength(1);
  });

  it("embed with empty array", async () => {
    const adapter = createMockAdapter();
    const result = await adapter.embed([]);
    expect(result.embeddings).toHaveLength(0);
  });

  it("async prepareInput is awaited", async () => {
    const adapter = createEmbeddingAdapter<string[], number[][]>({
      metadata: mockMetadata(),
      prepareInput: async (texts) => {
        await new Promise((r) => setTimeout(r, 1));
        return texts;
      },
      execute: async (texts) => texts.map(() => [1, 2, 3]),
      processOutput: (vecs) => ({ embeddings: vecs, dimensions: 3, model: "async-test" }),
    });

    const result = await adapter.embed(["test"]);
    expect(result.embeddings).toEqual([[1, 2, 3]]);
  });

  it("async processOutput is awaited", async () => {
    const adapter = createEmbeddingAdapter<string[], number[][]>({
      metadata: mockMetadata(),
      prepareInput: (texts) => texts,
      execute: async (texts) => texts.map(() => [4, 5, 6]),
      processOutput: async (vecs) => {
        await new Promise((r) => setTimeout(r, 1));
        return { embeddings: vecs, dimensions: 3, model: "async-process" };
      },
    });

    const result = await adapter.embed(["test"]);
    expect(result.embeddings).toEqual([[4, 5, 6]]);
  });

  it("execute errors propagate", async () => {
    const adapter = createEmbeddingAdapter<string[], never>({
      metadata: mockMetadata(),
      prepareInput: (texts) => texts,
      execute: async () => {
        throw new Error("provider down");
      },
      processOutput: (output) => output,
    });

    await expect(adapter.embed(["test"])).rejects.toThrow("provider down");
  });

  it("passes options through to prepareInput", async () => {
    let receivedOpts: any;

    const adapter = createEmbeddingAdapter<{ texts: string[]; dims?: number }, number[][]>({
      metadata: mockMetadata(),
      prepareInput: (texts, opts) => {
        receivedOpts = opts;
        return { texts, dims: opts?.dimensions };
      },
      execute: async (input) => input.texts.map(() => [1]),
      processOutput: (vecs) => ({ embeddings: vecs, dimensions: 1, model: "test" }),
    });

    await adapter.embed(["test"], { dimensions: 256 });
    expect(receivedOpts).toEqual({ dimensions: 256 });
  });
});

// ============================================================================
// isEmbeddingModel
// ============================================================================

describe("isEmbeddingModel", () => {
  it("returns true for valid EmbeddingModel", () => {
    const model = createMockAdapter();
    expect(isEmbeddingModel(model)).toBe(true);
  });

  it("returns false for null", () => {
    expect(isEmbeddingModel(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isEmbeddingModel(undefined)).toBe(false);
  });

  it("returns false for object without embed", () => {
    expect(isEmbeddingModel({ metadata: mockMetadata() })).toBe(false);
  });

  it("returns false for object without metadata", () => {
    expect(isEmbeddingModel({ embed: () => {} })).toBe(false);
  });

  it("returns false for non-function embed", () => {
    expect(isEmbeddingModel({ metadata: mockMetadata(), embed: "not a function" })).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isEmbeddingModel(42)).toBe(false);
    expect(isEmbeddingModel("string")).toBe(false);
    expect(isEmbeddingModel(true)).toBe(false);
  });
});
