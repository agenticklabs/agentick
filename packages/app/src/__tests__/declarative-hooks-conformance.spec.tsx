/**
 * **Every hook kind the `CommandHooks` TYPE accepts must actually fire when
 * declared in `createApp({ hooks })`.**
 *
 * This suite exists because that was false, silently, for the entire chunk half
 * of the surface. `CommandHooks` is `HooksOf & CommandAroundHooks &
 * ChunkHooksOf`, so TypeScript accepts `onModelGenerateStreamChunk` in the
 * declarative bag — while `hooksToMiddlewares` dropped every chunk entry on the
 * floor. No error, no warning; the hook simply never ran. Fixed by the
 * `chunkCarrier` in `@agentick/runtime`; this suite is what keeps it fixed.
 *
 * ## Why nothing caught it
 *
 * Every conformance suite in this repo certifies a PART. `runExecutorConformance`
 * drives the executor; harness suites drive harnesses. **Nothing stood where the
 * adopter stands** — writing the config a user writes, sending a message, and
 * asserting the thing they configured happened. The chunk half of the
 * declarative surface had zero coverage through `createApp`, so a type that
 * promised something the runtime discarded looked exactly like a type that
 * worked.
 *
 * The rule this encodes: **test at the entry point the user will type.** A
 * harness-level equivalent (`executor.hook(...)`) is not the same thing, and the
 * dimension it differs in is precisely the one that broke — the imperative path
 * routes chunk interceptors to `registerChunkInterceptor`, the declarative fold
 * did not.
 *
 * ## Two details this suite depends on, both found the hard way
 *
 *   - **Streaming is opt-in PER SEND** — `wantsStreaming = (input.stream ??
 *     false) && …`. It is not an adapter property. Without `stream: true` the
 *     loop takes `run()`, `model:generate_stream` never fires, and a chunk-hook
 *     assertion cannot tell "dropped by the fold" from "never streamed".
 *   - **The model executor must be built from an ADAPTER.** `createApp` attaches
 *     `inheritedInterceptors` only on the `model:` path; a caller-supplied
 *     `modelExecutor` (instance OR factory — `ExecutorFactoryDeps` carries no
 *     interceptor fields) receives NO app hooks at all.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { createApp } from "../react.js";
import type {
  AdapterDelta,
  ExecuteInput,
  LanguageModelExecutionResult,
  LanguageModelInput,
  LanguageModelTarget,
} from "@agentick/spec";
import type { LanguageModelAdapter, StreamAccumulatorView } from "@agentick/model";

const Agent = (): React.ReactElement => React.createElement("message", { role: "user" }, "hello");

const TARGET: LanguageModelTarget = {
  kind: "language-model",
  provider: "stub",
  modelId: "stub-v1",
};

/** A streaming adapter, so `model:generate_stream` and its nested provider call both run. */
function stubAdapter(): LanguageModelAdapter<{ text: string }, { raw: string }, unknown> {
  return {
    provider: "stub",
    target: TARGET,
    prepareRequest: (input: ExecuteInput<LanguageModelInput>) => ({
      model: input.target.modelId ?? "stub-v1",
    }),
    send: async () => ({ text: "ok" }),
    openStream: async function* () {
      yield { raw: "o" };
      yield { raw: "k" };
    },
    mapChunk: (chunk, accum: StreamAccumulatorView): readonly AdapterDelta[] => [
      ...(accum.textByBlock.has(0)
        ? []
        : ([{ type: "content-start", blockIndex: 0, blockType: "text" }] as const)),
      { type: "content-delta", blockIndex: 0, delta: chunk.raw },
    ],
    reconstructRaw: (accum: StreamAccumulatorView) => ({ text: accum.totalText() }),
    normalize: (raw): LanguageModelExecutionResult => ({
      specVersion: "2026-05-08",
      output: [{ type: "text", text: raw.text }],
      stopReason: "end",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }),
  };
}

/** Record of which declared hooks actually ran. */
interface Fired {
  readonly names: string[];
}

/**
 * Drive one STREAMING send through `createApp` with a declarative bag covering
 * every hook kind, and report which fired.
 */
async function driveWithDeclarativeHooks(): Promise<Fired> {
  const names: string[] = [];
  const mark = (name: string) => {
    if (!names.includes(name)) names.push(name);
  };

  const app = await createApp(React.createElement(Agent), {
    // The ADAPTER path — the only one that attaches app interceptors.
    model: stubAdapter(),
    hooks: {
      // Boundary hooks — the half that already worked.
      onBeforeModelGenerateStream: (input) => {
        mark("onBeforeModelGenerateStream");
        return input;
      },
      onAfterModelGenerateStream: (output) => {
        mark("onAfterModelGenerateStream");
        return output;
      },
      onBeforeModelProviderRequest: (input) => {
        mark("onBeforeModelProviderRequest");
        return input;
      },
      // Chunk hooks — the half that was silently dropped.
      onModelGenerateStreamChunk: {
        observe: () => {
          mark("onModelGenerateStreamChunk");
        },
      },
      onModelProviderRequestChunk: {
        observe: () => {
          mark("onModelProviderRequestChunk");
        },
      },
    },
  });

  try {
    const session = await app.createSession();
    // `stream: true` is load-bearing — see the module docblock.
    await (
      await session.send({ messages: [{ role: "user", content: "ping" }], stream: true })
    ).result;
  } finally {
    await app.closeApp();
  }

  return { names };
}

describe("declarative CommandHooks — every declared kind fires through createApp", () => {
  it("fires onBefore/onAfter boundary hooks", async () => {
    const { names } = await driveWithDeclarativeHooks();
    expect(names).toContain("onBeforeModelGenerateStream");
    expect(names).toContain("onAfterModelGenerateStream");
  });

  it("fires onBefore on the NESTED provider-request command", async () => {
    const { names } = await driveWithDeclarativeHooks();
    expect(names).toContain("onBeforeModelProviderRequest");
  });

  // These three were the defect. Chunk interceptors live in a per-`CommandRunner`
  // map while `inheritedInterceptors` carries `Middleware[]`, so an app-level
  // chunk hook had no route to the child harness that declares the streaming
  // command — and the fold dropped it rather than saying so. Closed by the
  // `chunkCarrier`: chunk entries now ride the SAME inheritance channel as inert
  // middleware and `BaseHarness` routes them onto the command runner at every
  // chain-entry point.
  it("fires on<Verb>Chunk declared in the DECLARATIVE bag", async () => {
    const { names } = await driveWithDeclarativeHooks();
    expect(names).toContain("onModelGenerateStreamChunk");
  });

  it("fires on<Verb>Chunk on the nested provider-request command", async () => {
    const { names } = await driveWithDeclarativeHooks();
    expect(names).toContain("onModelProviderRequestChunk");
  });

  // The invariant, stated once: the type must not promise what the runtime
  // discards. If a key is accepted by `CommandHooks` it must reach its seam.
  it("drops NOTHING that the type accepted", async () => {
    const { names } = await driveWithDeclarativeHooks();
    expect(names.sort()).toEqual(
      [
        "onAfterModelGenerateStream",
        "onBeforeModelGenerateStream",
        "onBeforeModelProviderRequest",
        "onModelGenerateStreamChunk",
        "onModelProviderRequestChunk",
      ].sort(),
    );
  });
});
