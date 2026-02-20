import { describe, it, expect, vi, beforeEach } from "vitest";
import { isEmbeddingModel } from "@agentick/core/model";

// Mock @huggingface/transformers before any imports use it
const mockExtractor = vi.fn();
const mockPipeline = vi.fn().mockResolvedValue(mockExtractor);
const mockEnv = { cacheDir: "" };

vi.mock("@huggingface/transformers", () => ({
  pipeline: mockPipeline,
  env: mockEnv,
}));

import { huggingfaceEmbedding } from "../embedding.js";

// ============================================================================
// Helpers
// ============================================================================

function fakeExtractorOutput(dims: number): { tolist: () => number[][] } {
  return {
    tolist: () => [Array.from({ length: dims }, (_, i) => i / dims)],
  };
}

beforeEach(() => {
  mockPipeline.mockClear();
  mockExtractor.mockClear();
  mockExtractor.mockResolvedValue(fakeExtractorOutput(384));
  mockEnv.cacheDir = "";
});

// ============================================================================
// Metadata
// ============================================================================

describe("huggingfaceEmbedding metadata", () => {
  it("default metadata", () => {
    const model = huggingfaceEmbedding();
    expect(model.metadata.id).toBe("hf:Xenova/all-MiniLM-L6-v2");
    expect(model.metadata.provider).toBe("huggingface");
    expect(model.metadata.dimensions).toBe(384);
    expect(model.metadata.model).toBe("Xenova/all-MiniLM-L6-v2");
  });

  it("custom model and dimensions", () => {
    const model = huggingfaceEmbedding({ model: "my/model", dimensions: 768 });
    expect(model.metadata.id).toBe("hf:my/model");
    expect(model.metadata.dimensions).toBe(768);
    expect(model.metadata.model).toBe("my/model");
  });

  it("is a valid EmbeddingModel", () => {
    expect(isEmbeddingModel(huggingfaceEmbedding())).toBe(true);
  });
});

// ============================================================================
// Lazy initialization
// ============================================================================

describe("lazy pipeline initialization", () => {
  it("does not load pipeline on construction", () => {
    huggingfaceEmbedding();
    expect(mockPipeline).not.toHaveBeenCalled();
  });

  it("loads pipeline on first embed call", async () => {
    const model = huggingfaceEmbedding();
    await model.embed(["hello"]);
    expect(mockPipeline).toHaveBeenCalledOnce();
    expect(mockPipeline).toHaveBeenCalledWith("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      dtype: "fp32",
    });
  });

  it("reuses pipeline on subsequent calls", async () => {
    const model = huggingfaceEmbedding();
    await model.embed(["first"]);
    await model.embed(["second"]);
    expect(mockPipeline).toHaveBeenCalledOnce();
  });

  it("passes custom dtype to pipeline", async () => {
    const model = huggingfaceEmbedding({ dtype: "q8" });
    await model.embed(["test"]);
    expect(mockPipeline).toHaveBeenCalledWith("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      dtype: "q8",
    });
  });

  it("sets cacheDir on env when configured", async () => {
    const model = huggingfaceEmbedding({ cacheDir: "/tmp/my-cache" });
    await model.embed(["test"]);
    expect(mockEnv.cacheDir).toBe("/tmp/my-cache");
  });

  it("does not set cacheDir when not configured", async () => {
    mockEnv.cacheDir = "original";
    const model = huggingfaceEmbedding();
    await model.embed(["test"]);
    expect(mockEnv.cacheDir).toBe("original");
  });
});

// ============================================================================
// Embed behavior
// ============================================================================

describe("embed", () => {
  it("returns correct shape for single text", async () => {
    const model = huggingfaceEmbedding();
    const result = await model.embed(["hello"]);

    expect(result.embeddings).toHaveLength(1);
    expect(result.embeddings[0]).toHaveLength(384);
    expect(result.dimensions).toBe(384);
    expect(result.model).toBe("Xenova/all-MiniLM-L6-v2");
  });

  it("embeds multiple texts sequentially", async () => {
    const model = huggingfaceEmbedding();
    const result = await model.embed(["hello", "world", "test"]);

    expect(result.embeddings).toHaveLength(3);
    expect(mockExtractor).toHaveBeenCalledTimes(3);

    // Verify each call passes the correct text with pooling/normalize
    expect(mockExtractor).toHaveBeenNthCalledWith(1, "hello", { pooling: "mean", normalize: true });
    expect(mockExtractor).toHaveBeenNthCalledWith(2, "world", { pooling: "mean", normalize: true });
    expect(mockExtractor).toHaveBeenNthCalledWith(3, "test", { pooling: "mean", normalize: true });
  });

  it("returns empty array for empty input", async () => {
    const model = huggingfaceEmbedding();
    const result = await model.embed([]);

    expect(result.embeddings).toHaveLength(0);
    expect(mockExtractor).not.toHaveBeenCalled();
  });

  it("converts tensor output to plain array", async () => {
    const typedArray = new Float32Array([0.1, 0.2, 0.3]);
    mockExtractor.mockResolvedValueOnce({
      tolist: () => [Array.from(typedArray)],
    });

    const model = huggingfaceEmbedding({ dimensions: 3 });
    const result = await model.embed(["test"]);

    expect(result.embeddings[0]).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
      expect.closeTo(0.3, 5),
    ]);
  });
});

// ============================================================================
// Warmup failure and retry
// ============================================================================

describe("warmup failure handling", () => {
  it("throws when pipeline fails to load", async () => {
    mockPipeline.mockRejectedValueOnce(new Error("ONNX runtime missing"));

    const model = huggingfaceEmbedding();
    await expect(model.embed(["test"])).rejects.toThrow(
      "HuggingFace model Xenova/all-MiniLM-L6-v2 failed to load",
    );
  });

  it("retries warmup after failure", async () => {
    // First call fails
    mockPipeline.mockRejectedValueOnce(new Error("temporary failure"));

    const model = huggingfaceEmbedding();
    await expect(model.embed(["test"])).rejects.toThrow("failed to load");

    // Second call succeeds — pipeline should be retried (loading was reset to null)
    mockPipeline.mockResolvedValueOnce(mockExtractor);
    const result = await model.embed(["retry"]);
    expect(result.embeddings).toHaveLength(1);
    expect(mockPipeline).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// Instance isolation (no shared state)
// ============================================================================

describe("instance isolation", () => {
  it("separate instances get independent pipelines", async () => {
    const model1 = huggingfaceEmbedding({ model: "model-a" });
    const model2 = huggingfaceEmbedding({ model: "model-b" });

    await model1.embed(["test"]);
    await model2.embed(["test"]);

    expect(mockPipeline).toHaveBeenCalledTimes(2);
    expect(mockPipeline).toHaveBeenNthCalledWith(1, "feature-extraction", "model-a", {
      dtype: "fp32",
    });
    expect(mockPipeline).toHaveBeenNthCalledWith(2, "feature-extraction", "model-b", {
      dtype: "fp32",
    });
  });

  it("same model ID with different dtype gets separate pipelines", async () => {
    const fp32 = huggingfaceEmbedding({ dtype: "fp32" });
    const q8 = huggingfaceEmbedding({ dtype: "q8" });

    await fp32.embed(["test"]);
    await q8.embed(["test"]);

    expect(mockPipeline).toHaveBeenCalledTimes(2);
    expect(mockPipeline).toHaveBeenNthCalledWith(
      1,
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
      { dtype: "fp32" },
    );
    expect(mockPipeline).toHaveBeenNthCalledWith(
      2,
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
      { dtype: "q8" },
    );
  });

  it("failure in one instance does not affect another", async () => {
    mockPipeline.mockRejectedValueOnce(new Error("broken"));

    const broken = huggingfaceEmbedding();
    const healthy = huggingfaceEmbedding();

    await expect(broken.embed(["test"])).rejects.toThrow("failed to load");

    mockPipeline.mockResolvedValueOnce(mockExtractor);
    const result = await healthy.embed(["test"]);
    expect(result.embeddings).toHaveLength(1);
  });
});

// ============================================================================
// Concurrent embed calls during warmup
// ============================================================================

describe("concurrent warmup", () => {
  it("deduplicates warmup when multiple embeds fire before pipeline ready", async () => {
    let resolveWarmup!: (value: typeof mockExtractor) => void;
    mockPipeline.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveWarmup = resolve;
      }),
    );

    const model = huggingfaceEmbedding();

    // Fire 3 concurrent embed calls — all should share one warmup
    const p1 = model.embed(["a"]);
    const p2 = model.embed(["b"]);
    const p3 = model.embed(["c"]);

    // Resolve the single warmup
    resolveWarmup(mockExtractor);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.embeddings).toHaveLength(1);
    expect(r2.embeddings).toHaveLength(1);
    expect(r3.embeddings).toHaveLength(1);

    // Only one pipeline load
    expect(mockPipeline).toHaveBeenCalledOnce();
  });
});
