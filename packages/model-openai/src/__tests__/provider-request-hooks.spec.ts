/**
 * `model:provider-request` boundary hooks driven through the REAL `openai()`
 * adapter + a stub SDK client (ADR 52 amendment 2026-07-22). Proves the hook
 * sees the actual OpenAI wire request and that a transform on it reaches the
 * SDK client the adapter calls.
 */

import { describe, expect, it } from "vitest";

import type { ChatCompletionCreateParams } from "openai/resources/chat/completions";
import type { LanguageModelTarget, RenderedTree } from "@agentick/spec";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";

import { LanguageModelExecutor } from "@agentick/model-executor";

import { openai } from "../openai-adapter.js";
import {
  StubOpenAIClient,
  asClient,
  mkCompletion,
  mkContentChunk,
  mkFinishChunk,
} from "./stub-openai-client.js";

function tree(): RenderedTree {
  return {
    specVersion: "2026-05-08",
    context: {
      entries: [
        { kind: "message", id: "m1", role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    },
  };
}
const target: LanguageModelTarget = {
  kind: "language-model",
  provider: "openai",
  modelId: "gpt-4o-mini",
};

async function makeExecutor(stub: StubOpenAIClient, stream = false) {
  const exec = new LanguageModelExecutor(
    "exec-openai-pr",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    { adapter: openai("gpt-4o-mini", { client: asClient(stub), stream }) },
  );
  await exec.ready;
  return exec;
}

describe("openai() — model:provider-request hooks", () => {
  it("onBeforeModelProviderRequest sees the native OpenAI request (messages)", async () => {
    const stub = new StubOpenAIClient([
      { kind: "non-streaming", completion: mkCompletion({ text: "ok" }) },
    ]);
    const exec = await makeExecutor(stub);
    let seen: ChatCompletionCreateParams | undefined;
    const off = exec.hook({
      onBeforeModelProviderRequest: (request) => {
        seen = request as ChatCompletionCreateParams;
      },
    });

    await exec.run({ compiled: tree(), target, tools: [] });

    expect(seen).toBeDefined();
    expect(Array.isArray(seen!.messages)).toBe(true);
    expect(seen!.model).toBe("gpt-4o-mini");

    off();
    await exec.close();
  });

  it("a transform on the native request reaches the SDK client", async () => {
    const stub = new StubOpenAIClient([
      { kind: "non-streaming", completion: mkCompletion({ text: "ok" }) },
    ]);
    const exec = await makeExecutor(stub);
    const off = exec.hook({
      onBeforeModelProviderRequest: (request) => ({
        ...(request as ChatCompletionCreateParams),
        max_tokens: 4242,
      }),
    });

    await exec.run({ compiled: tree(), target, tools: [] });

    // The transformed field reached the SDK client call.
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.params.max_tokens).toBe(4242);

    off();
    await exec.close();
  });

  it("onModelProviderRequestChunk observes raw ChatCompletionChunks pre-mapChunk", async () => {
    const stub = new StubOpenAIClient([
      {
        kind: "streaming",
        chunks: [
          mkContentChunk({ delta: "he" }),
          mkContentChunk({ delta: "llo" }),
          mkFinishChunk({}),
        ],
      },
    ]);
    const exec = await makeExecutor(stub, true);
    const observed: unknown[] = [];
    const off = exec.hooks.onModelProviderRequestChunk({
      observe: (chunk) => {
        observed.push(chunk);
      },
    });

    const stream = exec.executeStream({
      targetInput: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      target,
    });
    for await (const _ of stream) {
      /* drain */
    }
    await stream.result;

    // Raw provider chunks — `object: "chat.completion.chunk"` with `.choices`,
    // NOT canonical AdapterDeltas (`.type`).
    expect(observed.length).toBeGreaterThan(0);
    for (const c of observed) {
      expect((c as { object?: string }).object).toBe("chat.completion.chunk");
      expect((c as { type?: unknown }).type).toBeUndefined();
    }

    off();
    await exec.close();
  });
});
