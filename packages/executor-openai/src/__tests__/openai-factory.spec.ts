/**
 * Smoke tests for the `openai(modelId, options?)` factory.
 */

import { describe, expect, it } from "vitest";

import { openai } from "../openai-factory.js";
import { StubOpenAIClient, asClient, mkCompletion } from "./stub-openai-client.js";

describe("openai() factory", () => {
  it("returns a self-describing executor with the target derived from modelId", async () => {
    // Provide a stub client so the SDK doesn't demand OPENAI_API_KEY
    // in test environments.
    const stub = new StubOpenAIClient([
      { kind: "non-streaming", completion: mkCompletion({ text: "ok" }) },
    ]);
    const exec = openai("gpt-4o", { client: asClient(stub) });
    await exec.ready;
    expect(exec.family).toBe("language-model");
    expect(exec.target).toMatchObject({
      kind: "language-model",
      provider: "openai",
      modelId: "gpt-4o",
    });
  });

  it("forwards a stub client + apiKey through to OpenAIExecutor options", async () => {
    const stub = new StubOpenAIClient([
      { kind: "non-streaming", completion: mkCompletion({ text: "hi" }) },
    ]);
    const exec = openai("gpt-4o-mini", { client: asClient(stub) });
    await exec.ready;
    expect(exec.target.modelId).toBe("gpt-4o-mini");
  });

  it("accepts a target override", async () => {
    const stub = new StubOpenAIClient([
      { kind: "non-streaming", completion: mkCompletion({ text: "ok" }) },
    ]);
    const exec = openai("custom-model", {
      client: asClient(stub),
      target: {
        kind: "language-model",
        provider: "openai",
        modelId: "custom-model",
        capabilities: { supportsTools: false, contextWindow: 200_000 },
      },
    });
    await exec.ready;
    expect(exec.target.capabilities?.contextWindow).toBe(200_000);
    expect(exec.target.capabilities?.supportsTools).toBe(false);
  });
});
