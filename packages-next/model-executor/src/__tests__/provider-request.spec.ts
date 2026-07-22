/**
 * `model:provider-request` — the nested provider-SDK-call command (ADR 52
 * amendment 2026-07-22). These tests prove the boundary the split created:
 *
 *   - `onBeforeModelProviderRequest` sees the NATIVE request `prepareRequest`
 *     produced (a provider-shaped params object, not the canonical
 *     `LanguageModelInput`) and a transform on it reaches the SDK call.
 *   - `onAfterModelProviderRequest` sees the RAW provider response (`TRaw`).
 *   - `onModelProviderRequestChunk` observes RAW provider chunks (`TChunk`)
 *     PRE-`mapChunk` (before canonical-delta normalization).
 *   - The nested op is journaled with `parentOpId` → the enclosing
 *     `model:generate[_stream]` op (causality intact).
 *   - Aborting mid-provider-stream interrupts the nested command cleanly —
 *     NO bogus `onAfterModelProviderRequest` fires.
 *   - A BYO adapter (a plain object satisfying `LanguageModelAdapter`, NOT
 *     built through `defineLanguageModelAdapter`) works identically — the
 *     interface is the contract; the factory is sugar.
 *   - The fake executor mints the same command, so conformance runs against
 *     BOTH the real executor and the fake.
 */

import { Chunk, Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type {
  AdapterDelta,
  ExecuteInput,
  ExecutionTarget,
  LanguageModelExecutionResult,
  LanguageModelInput,
  LanguageModelTarget,
  ProtocolEvent,
  RenderedTree,
} from "@agentick/spec-next";
import type { LanguageModelAdapter, StreamAccumulatorView } from "@agentick/model-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";

import { LanguageModelExecutor } from "../language-model-executor.js";
import { FakeLanguageModelExecutor } from "../fake-language-model-executor.js";

// ── The provider currencies (distinctive shapes so the tests can tell the
//    NATIVE request / RAW response / RAW chunk apart from the canonical ones) ──

/** Provider-native request — carries `maxTokens`, a field NO canonical shape has. */
interface NativeReq {
  readonly model: string;
  readonly maxTokens: number;
  injected?: boolean;
}
/** Raw provider chunk — has `.raw`, NOT the AdapterDelta `.type` discriminant. */
interface RawChunk {
  readonly raw: string;
}
/** Raw provider response — has `.text`, NOT the canonical `.output`/`.stopReason`. */
interface RawResp {
  readonly text: string;
}

const TARGET: LanguageModelTarget = {
  kind: "language-model",
  provider: "stub",
  modelId: "stub-v1",
};

interface StubHandle {
  readonly adapter: LanguageModelAdapter<RawResp, RawChunk, NativeReq>;
  /** Native requests that actually reached `send`/`openStream` (post-onBefore). */
  readonly sent: NativeReq[];
}

/**
 * A stub adapter whose `openStream` optionally BLOCKS after the first chunk
 * until the abort signal fires — so the abort-mid-stream test can interrupt a
 * live provider stream.
 */
function stubAdapter(opts: { blockAfterFirst?: boolean } = {}): StubHandle {
  const sent: NativeReq[] = [];
  const adapter: LanguageModelAdapter<RawResp, RawChunk, NativeReq> = {
    provider: "stub",
    target: TARGET,
    streamByDefault: false,
    prepareRequest: (input: ExecuteInput<LanguageModelInput>): NativeReq => ({
      model: input.target.modelId ?? "stub-v1",
      maxTokens: 7,
    }),
    send: async (request: NativeReq): Promise<RawResp> => {
      sent.push(request);
      return { text: "ok" };
    },
    openStream: async function* (
      request: NativeReq,
      signal: AbortSignal | undefined,
    ): AsyncIterable<RawChunk> {
      sent.push(request);
      yield { raw: "he" };
      if (opts.blockAfterFirst) {
        await new Promise<void>((_res, rej) => {
          if (signal?.aborted) return rej(new Error("aborted"));
          signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
        });
      }
      yield { raw: "llo" };
    },
    mapChunk: (chunk: RawChunk, accum: StreamAccumulatorView): readonly AdapterDelta[] => [
      ...(accum.textByBlock.has(0)
        ? []
        : ([{ type: "content-start", blockIndex: 0, blockType: "text" }] as const)),
      { type: "content-delta", blockIndex: 0, delta: chunk.raw },
    ],
    reconstructRaw: (accum: StreamAccumulatorView): RawResp => ({ text: accum.totalText() }),
    normalize: (raw: RawResp): LanguageModelExecutionResult => ({
      specVersion: "2026-05-08",
      output: [{ type: "text", text: raw.text }],
      stopReason: "end",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }),
  };
  return { adapter, sent };
}

async function makeExecutor(handle: StubHandle) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const exec = new LanguageModelExecutor<RawResp, RawChunk>("exec-pr", journal, bus, inbox, {
    adapter: handle.adapter,
  });
  await exec.ready;
  return { exec, journal };
}

const emptyTree = (): RenderedTree => ({
  specVersion: "2026-05-08",
  context: {
    entries: [{ kind: "message", id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }],
  },
});
const execInput = (): ExecuteInput<LanguageModelInput> => ({
  targetInput: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
  target: TARGET,
});

async function readJournal(journal: MemoryJournal): Promise<readonly ProtocolEvent[]> {
  const chunk = await Effect.runPromise(
    Stream.runCollect(journal.readByQuery({ surface: "model" }, "beginning")),
  );
  return Array.from(Chunk.toReadonlyArray(chunk));
}

describe("model:provider-request — boundary hooks", () => {
  it("onBeforeModelProviderRequest sees the NATIVE request (a provider-specific field)", async () => {
    const handle = stubAdapter();
    const { exec } = await makeExecutor(handle);
    let seen: NativeReq | undefined;
    const off = exec.hook({
      onBeforeModelProviderRequest: (request) => {
        seen = request as NativeReq;
      },
    });

    await exec.execute(execInput());

    // NOT the canonical LanguageModelInput — the provider-shaped request.
    expect(seen).toBeDefined();
    expect(seen!.maxTokens).toBe(7);
    expect(seen!.model).toBe("stub-v1");
    expect((seen as unknown as { messages?: unknown }).messages).toBeUndefined();

    off();
    await exec.close();
  });

  it("a transform on onBeforeModelProviderRequest reaches the SDK call", async () => {
    const handle = stubAdapter();
    const { exec } = await makeExecutor(handle);
    const off = exec.hook({
      onBeforeModelProviderRequest: (request) => ({
        ...(request as NativeReq),
        injected: true,
      }),
    });

    await exec.execute(execInput());

    // The transformed native request is what `send` actually received.
    expect(handle.sent).toHaveLength(1);
    expect(handle.sent[0]!.injected).toBe(true);

    off();
    await exec.close();
  });

  it("onAfterModelProviderRequest sees the RAW provider response", async () => {
    const handle = stubAdapter();
    const { exec } = await makeExecutor(handle);
    let after: RawResp | undefined;
    const off = exec.hook({
      onAfterModelProviderRequest: (raw) => {
        after = raw as RawResp;
      },
    });

    await exec.execute(execInput());

    // The raw provider response (`{ text }`), not the normalized result.
    expect(after).toEqual({ text: "ok" });

    off();
    await exec.close();
  });

  it("onModelProviderRequestChunk observes RAW chunks PRE-mapChunk", async () => {
    const handle = stubAdapter();
    const { exec } = await makeExecutor(handle);
    const observed: unknown[] = [];
    const off = exec.hooks.onModelProviderRequestChunk({
      observe: (chunk) => {
        observed.push(chunk);
      },
    });

    const stream = exec.executeStream(execInput());
    for await (const _ of stream) {
      /* drain */
    }
    await stream.result;

    // Raw provider chunks (`{ raw }`), NOT canonical AdapterDeltas (`{ type }`).
    expect(observed).toEqual([{ raw: "he" }, { raw: "llo" }]);
    for (const c of observed) {
      expect((c as { raw?: unknown }).raw).toBeDefined();
      expect((c as { type?: unknown }).type).toBeUndefined();
    }

    off();
    await exec.close();
  });
});

describe("model:provider-request — journal causality", () => {
  it("journals the nested op with parentOpId → the enclosing generate op", async () => {
    const handle = stubAdapter();
    const { exec, journal } = await makeExecutor(handle);

    await exec.execute(execInput());

    const events = await readJournal(journal);
    const generate = events.find(
      (e) => e.name === "model:command:generate" && e.phase === "requested",
    );
    const providerReq = events.find(
      (e) => e.name === "model:command:provider-request" && e.phase === "requested",
    );
    expect(generate).toBeDefined();
    expect(providerReq).toBeDefined();
    // Causality: generate → provider-request.
    expect(providerReq!.parentOpId).toBe(generate!.opId);
    // A terminal for the nested op is journaled too.
    expect(
      events.some((e) => e.name === "model:command:provider-request" && e.phase === "terminal"),
    ).toBe(true);

    await exec.close();
  });
});

describe("model:provider-request — abort mid-stream", () => {
  it("interrupts the nested command cleanly — no bogus onAfter", async () => {
    const handle = stubAdapter({ blockAfterFirst: true });
    const { exec } = await makeExecutor(handle);
    let afterFired = 0;
    const off = exec.hook({
      onAfterModelProviderRequest: () => {
        afterFired += 1;
      },
    });

    const executionId = "exec-abort-1";
    const stream = exec.executeStream({ ...execInput(), scope: { executionId } });
    const iter = stream[Symbol.asyncIterator]();
    // Pull until we observe the first real content delta, then abort.
    await iter.next();
    await exec.abort({ executionId, reason: "test-abort" });

    // Drain / settle the stream; a cancellation completes it cleanly.
    try {
      for (let n = await iter.next(); !n.done; n = await iter.next()) {
        /* drain remaining */
      }
    } catch {
      /* provider-abort may surface on the iterator — fine */
    }
    await stream.result.catch(() => {});

    // The provider stream never completed, so onAfter must NOT have fired.
    expect(afterFired).toBe(0);

    off();
    await exec.close();
  });
});

describe("model:provider-request — BYO adapter (no factory)", () => {
  it("a plain object satisfying LanguageModelAdapter works through the executor", async () => {
    // NOTE: NOT built via defineLanguageModelAdapter — the interface is the
    // contract, the factory is sugar.
    let sawNativeRequest = false;
    const byo: LanguageModelAdapter<RawResp, RawChunk, NativeReq> = {
      provider: "byo",
      target: TARGET,
      prepareRequest: (input) => ({ model: input.target.modelId ?? "byo", maxTokens: 3 }),
      send: async () => ({ text: "byo-ok" }),
      mapChunk: () => [],
      reconstructRaw: () => ({ text: "byo-ok" }),
      normalize: (raw) => ({
        specVersion: "2026-05-08",
        output: [{ type: "text", text: raw.text }],
        stopReason: "end",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      }),
    };
    const journal = new MemoryJournal();
    const exec = new LanguageModelExecutor<RawResp, RawChunk>(
      "exec-byo",
      journal,
      new LocalEventBus(),
      new LocalInbox(),
      { adapter: byo },
    );
    await exec.ready;
    const off = exec.hook({
      onBeforeModelProviderRequest: (request) => {
        if ((request as NativeReq).maxTokens === 3) sawNativeRequest = true;
      },
    });

    const terminal = await exec.run({ compiled: emptyTree(), target: TARGET, tools: [] });

    expect(terminal.outcome).toBe("succeeded");
    if (terminal.outcome === "succeeded") {
      expect(terminal.result.output[0]).toMatchObject({ type: "text", text: "byo-ok" });
    }
    expect(sawNativeRequest).toBe(true);

    off();
    await exec.close();
  });
});

describe("model:provider-request — fake executor conformance", () => {
  it("the fake mints the same command: onBefore fires + parentOpId threads", async () => {
    const journal = new MemoryJournal();
    const fake = new FakeLanguageModelExecutor(
      "fake-pr",
      journal,
      new LocalEventBus(),
      new LocalInbox(),
      {},
    );
    await fake.ready;
    let beforeFired = 0;
    const off = fake.hook({
      onBeforeModelProviderRequest: () => {
        beforeFired += 1;
      },
    });

    await fake.execute({
      targetInput: { messages: [] },
      target: { kind: "language-model", provider: "mock", modelId: "mock-v1" } as ExecutionTarget,
      scope: { executionId: "fake-exec-1" },
    });

    expect(beforeFired).toBe(1);

    const chunk = await Effect.runPromise(
      Stream.runCollect(journal.readByQuery({ surface: "model" }, "beginning")),
    );
    const events = Array.from(Chunk.toReadonlyArray(chunk));
    const generate = events.find(
      (e) => e.name === "model:command:generate" && e.phase === "requested",
    );
    const providerReq = events.find(
      (e) => e.name === "model:command:provider-request" && e.phase === "requested",
    );
    expect(generate).toBeDefined();
    expect(providerReq).toBeDefined();
    expect(providerReq!.parentOpId).toBe(generate!.opId);

    off();
    await fake.close();
  });
});
