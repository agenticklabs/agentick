/**
 * Smoke tests for the `openai(modelId, options?)` factory.
 */

import { describe, expect, it } from "vitest";

import { openai } from "../openai-factory.js";
import { StubOpenAIClient, asClient, mkCompletion } from "./stub-openai-client.js";

describe("openai() factory", () => {
  it("returns an ExecutorFactory marked with executorFactory: true", () => {
    const f = openai("gpt-4o");
    expect(typeof f).toBe("function");
    expect((f as unknown as { executorFactory?: boolean }).executorFactory).toBe(true);
  });

  it("constructs a self-describing executor when called standalone", async () => {
    const stub = new StubOpenAIClient([
      { kind: "non-streaming", completion: mkCompletion({ text: "ok" }) },
    ]);
    const exec = openai("gpt-4o", { client: asClient(stub) })();
    await exec.ready;
    expect(exec.family).toBe("language-model");
    expect(exec.target).toMatchObject({
      kind: "language-model",
      provider: "openai",
      modelId: "gpt-4o",
    });
  });

  it("accepts a target override through the factory options", async () => {
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
    })();
    await exec.ready;
    expect(exec.target.capabilities?.contextWindow).toBe(200_000);
    expect(exec.target.capabilities?.supportsTools).toBe(false);
  });
});
