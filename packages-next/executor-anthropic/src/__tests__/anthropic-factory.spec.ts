/**
 * Smoke tests for the `anthropic(modelId, options?)` factory.
 */

import { describe, expect, it } from "vitest";

import { anthropic } from "../anthropic-factory.js";
import { StubAnthropicClient, asClient, mkMessage } from "./stub-anthropic-client.js";

describe("anthropic() factory", () => {
  it("returns an ExecutorFactory marked with executorFactory: true", () => {
    const f = anthropic("claude-3-5-sonnet-latest");
    expect(typeof f).toBe("function");
    expect((f as unknown as { executorFactory?: boolean }).executorFactory).toBe(true);
  });

  it("constructs a self-describing executor when called standalone", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "ok" }) },
    ]);
    const exec = anthropic("claude-3-5-sonnet-latest", { client: asClient(stub) })();
    await exec.ready;
    expect(exec.family).toBe("language-model");
    expect(exec.target).toMatchObject({
      kind: "language-model",
      provider: "anthropic",
      modelId: "claude-3-5-sonnet-latest",
    });
  });

  it("accepts a target override through the factory options", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "ok" }) },
    ]);
    const exec = anthropic("custom-model", {
      client: asClient(stub),
      target: {
        kind: "language-model",
        provider: "anthropic",
        modelId: "custom-model",
        capabilities: { supportsTools: false, contextWindow: 1_000_000 },
      },
    })();
    await exec.ready;
    expect(exec.target.capabilities?.contextWindow).toBe(1_000_000);
    expect(exec.target.capabilities?.supportsTools).toBe(false);
  });

  it("propagates model id positionally even when options.model is set differently", async () => {
    const stub = new StubAnthropicClient([
      { kind: "non-streaming", message: mkMessage({ text: "ok" }) },
    ]);
    const exec = anthropic("claude-3-opus-latest", {
      client: asClient(stub),
    })();
    await exec.ready;
    expect(exec.target.modelId).toBe("claude-3-opus-latest");
  });
});
