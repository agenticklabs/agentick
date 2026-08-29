/**
 * ADR 105 — gateway-level model-family defaults cascade into hosted apps on
 * the telemetry rule: an app that omits `images` / `embeddings` inherits the
 * gateway's ADAPTER (and builds its own executor); one that supplies its own
 * wins.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionTarget, ImageModelAdapter } from "@agentick/spec";
import { SPEC_VERSION } from "@agentick/spec";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { CompilerHarness } from "@agentick/compiler-react";

import { createGateway, type GatewayHarness } from "../index.js";

const NULL_ROOT = null as unknown;
const target: ExecutionTarget = { kind: "language-model", provider: "mock", modelId: "mock-v1" };

function imageAdapter(modelId: string): ImageModelAdapter {
  return {
    provider: "stub",
    target: { kind: "image-model", provider: "stub", modelId },
    async generate() {
      return {
        specVersion: SPEC_VERSION,
        output: [],
        images: [{ data: "AA==", mimeType: "image/png" }],
      };
    },
  };
}

const gateways: GatewayHarness[] = [];
afterEach(async () => {
  while (gateways.length) await gateways.pop()!.close();
});

async function rig(gatewayImages: ImageModelAdapter) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("m", journal, bus, inbox, {
    scripted: {
      result: {
        specVersion: SPEC_VERSION,
        output: [{ type: "text", text: "ok" }],
        stopReason: "end",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    },
  });
  await executor.ready;
  const gateway = await createGateway({ journal, bus, inbox, images: gatewayImages });
  gateways.push(gateway);
  await gateway.listen();
  const app = (appId: string, images?: ImageModelAdapter) =>
    gateway.createApp({
      appId,
      rootElement: NULL_ROOT,
      options: {
        compiler: new CompilerHarness(`r-${appId}`, journal, bus, inbox),
        modelExecutor: executor,
        target,
        journal,
        bus,
        inbox,
        ...(images !== undefined ? { images } : {}),
      },
    });
  return { app };
}

describe("gateway model-family defaults", () => {
  it("an app that omits images inherits the gateway adapter and builds its own executor", async () => {
    const { app } = await rig(imageAdapter("gateway-imagen"));
    const a = (await app("a")) as unknown as {
      images?: { family: string; target: ExecutionTarget };
    };
    const b = (await app("b")) as unknown as {
      images?: { family: string; target: ExecutionTarget };
    };

    expect(a.images?.family).toBe("image-model");
    expect(a.images?.target.modelId).toBe("gateway-imagen");
    // One adapter, two executors — each app on its own substrate/cascade.
    expect(b.images).toBeDefined();
    expect(b.images).not.toBe(a.images);
  });

  it("an app-supplied adapter wins over the gateway default", async () => {
    const { app } = await rig(imageAdapter("gateway-imagen"));
    const own = (await app("own", imageAdapter("app-imagen"))) as unknown as {
      images?: { target: ExecutionTarget };
    };
    expect(own.images?.target.modelId).toBe("app-imagen");
  });
});
