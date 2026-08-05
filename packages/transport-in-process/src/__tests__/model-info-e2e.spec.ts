/**
 * `app.modelInfo()` end to end — the real `GatewayHarness` over
 * `inProcessTransport`, driven through the typed client handle.
 *
 * The consumer this exists for is a context-window gauge. It already has the
 * NUMERATOR: `metadata.usage.inputTokens` rides every assistant entry, and the
 * timeline hands the client full entries. What it lacks is the denominator, and
 * the denominator is a property of the MODEL rather than of any message — so
 * stamping it on every entry would pay bytes per message for a fact with two
 * values per conversation.
 *
 * The client must ASK rather than derive: an adopter's `models` registry is
 * merged over the seed server-side, so a client resolving from the seed alone
 * would compute a different window than the server actually used.
 */

import { describe, expect, it } from "vitest";

import { createClient } from "@agentick/client-core";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { createGateway } from "@agentick/gateway";
import { fakeCompiler } from "@agentick/compiler/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";

import { inProcessTransport } from "../index.js";

async function makeStack(models?: Record<string, unknown>) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("model-info-exec", journal, bus, inbox, {
    scripted: [],
  });
  await executor.ready;

  const gateway = await createGateway();
  await gateway.listen();
  await gateway.createApp({
    appId: "mi-app",
    rootElement: null,
    options: {
      modelExecutor: executor,
      compiler: fakeCompiler(),
      ...(models !== undefined ? { models: models as never } : {}),
    },
  });

  const client = await createClient({ transport: inProcessTransport({ gateway }) });
  await client.connect();
  return { client, cleanup: async () => (await client.close(), await gateway.close()) };
}

describe("app/model_info", () => {
  it("answers from the seed catalog, echoing the request back with it", async () => {
    const { client, cleanup } = await makeStack();
    const res = await client.app("mi-app").modelInfo("google", "gemini-3.6-flash");

    // Echoed, so a cached row is self-describing and a late reply cannot be
    // filed under the wrong key.
    expect(res.provider).toBe("google");
    expect(res.modelId).toBe("gemini-3.6-flash");

    expect(res.info?.contextWindow).toBe(1048576);
    expect(res.info?.maxOutputTokens).toBe(65536);
    expect(res.info?.pricing?.outputPerMTok).toBe(7.5);
    await cleanup();
  });

  it("resolves a dated model id to its base row (longest prefix)", async () => {
    const { client, cleanup } = await makeStack();
    const res = await client.app("mi-app").modelInfo("google", "gemini-3.5-flash-002");
    expect(res.info?.pricing?.outputPerMTok).toBe(9);
    await cleanup();
  });

  it("an unknown model answers null — the catalog never fabricates", async () => {
    const { client, cleanup } = await makeStack();
    const res = await client.app("mi-app").modelInfo("google", "gemini-99-imaginary");
    // null, not a throw: "no layer describes this" is a legitimate answer, and
    // a gauge with no denominator should render unknown rather than zero.
    expect(res.info).toBeNull();
    await cleanup();
  });

  it("the adopter's registry wins over the seed — which is why the client asks", async () => {
    const { client, cleanup } = await makeStack({
      "google/gemini-3.6-flash": { contextWindow: 42_000 },
    });
    const res = await client.app("mi-app").modelInfo("google", "gemini-3.6-flash");
    expect(res.info?.contextWindow).toBe(42_000);
    await cleanup();
  });

  it("never ships the tokenEstimator — a function cannot cross a wire", async () => {
    const { client, cleanup } = await makeStack({
      "google/gemini-3.6-flash": { contextWindow: 7, tokenEstimator: () => 1 },
    });
    const res = await client.app("mi-app").modelInfo("google", "gemini-3.6-flash");
    expect(res.info).toBeDefined();
    expect(res.info).not.toHaveProperty("tokenEstimator");
    expect(JSON.parse(JSON.stringify(res.info))).toEqual(res.info);
    await cleanup();
  });
});
