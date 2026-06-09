/**
 * Smoke tests for the `google(modelId, options?)` factory.
 */

import { describe, expect, it } from "vitest";

import { google } from "../google-factory.js";
import { StubGoogleClient, asClient, mkResponse } from "./stub-google-client.js";

describe("google() factory", () => {
  it("returns an ExecutorFactory marked with executorFactory: true", () => {
    const f = google("gemini-2.5-flash");
    expect(typeof f).toBe("function");
    expect((f as unknown as { executorFactory?: boolean }).executorFactory).toBe(true);
  });

  it("constructs a self-describing executor when called standalone", async () => {
    const stub = new StubGoogleClient([
      { kind: "non-streaming", response: mkResponse({ text: "ok" }) },
    ]);
    const exec = google("gemini-2.5-flash", { client: asClient(stub) })();
    await exec.ready;
    expect(exec.family).toBe("language-model");
    expect(exec.target).toMatchObject({
      kind: "language-model",
      provider: "google",
      modelId: "gemini-2.5-flash",
    });
  });

  it("accepts a target override through the factory options", async () => {
    const stub = new StubGoogleClient([
      { kind: "non-streaming", response: mkResponse({ text: "ok" }) },
    ]);
    const exec = google("custom-model", {
      client: asClient(stub),
      target: {
        kind: "language-model",
        provider: "google",
        modelId: "custom-model",
        capabilities: { supportsTools: false, contextWindow: 2_000_000 },
      },
    })();
    await exec.ready;
    expect(exec.target.capabilities?.contextWindow).toBe(2_000_000);
    expect(exec.target.capabilities?.supportsTools).toBe(false);
  });

  it("propagates model id positionally even when no options.model is set", async () => {
    const stub = new StubGoogleClient([
      { kind: "non-streaming", response: mkResponse({ text: "ok" }) },
    ]);
    const exec = google("gemini-1.5-pro", {
      client: asClient(stub),
    })();
    await exec.ready;
    expect(exec.target.modelId).toBe("gemini-1.5-pro");
  });
});
