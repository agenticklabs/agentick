/**
 * WHERE the media screen runs, which is the entire design of it.
 *
 * `capabilities.media` declares what a target can carry and the framework — not the
 * adapter — enforces it, so no adapter can forget. But "the framework enforces it"
 * is only correct at one specific point in the pipeline, and two earlier ones are
 * actively wrong:
 *
 *   - inside `defaultProject`: bypassed by any adapter supplying its own `project`
 *     (Anthropic does), which is the "trust every adapter" problem the declaration
 *     exists to remove;
 *   - in `projectImpl`: runs BEFORE the `model:generate` command, so it drops parts
 *     that `onBeforeModelGenerate` was about to FIX — an app resolving its own
 *     `reference` sources at that seam finds its attachments already gone.
 *
 * Both were real, and the second is the one worth a permanent test: it silently
 * breaks the documented way to handle a `reference` source, and it breaks it in the
 * direction where everything still succeeds.
 */

import { describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";

import type {
  AdapterDelta,
  ExecuteInput,
  ExecutionTarget,
  LanguageModelExecutionResult,
  LanguageModelInput,
  LanguageModelMessage,
  MediaSource,
} from "@agentick/spec";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { LanguageModelAdapter, StreamAccumulatorView } from "@agentick/model";

import { LanguageModelExecutor } from "../language-model-executor.js";

interface StubRaw {
  readonly text: string;
}

/** Carries base64 images and `gs:`-scheme URLs; a `reference` is declared unprojectable. */
const TARGET: ExecutionTarget = {
  kind: "language-model",
  provider: "stub",
  modelId: "stub-v1",
  capabilities: { media: { image: ["base64", "url"], urlSchemes: ["https", "gs"] } },
};

const imagePart = (source: MediaSource): LanguageModelMessage["content"][number] =>
  ({ type: "image", source }) as LanguageModelMessage["content"][number];

const textPart = (text: string): LanguageModelMessage["content"][number] =>
  ({ type: "text", text }) as LanguageModelMessage["content"][number];

/** Records exactly what the adapter was handed — the request that would go on the wire. */
function recordingAdapter(): {
  adapter: LanguageModelAdapter<StubRaw, never>;
  seen: () => ReadonlyArray<readonly LanguageModelMessage[]>;
} {
  const seen: Array<readonly LanguageModelMessage[]> = [];
  const adapter: LanguageModelAdapter<StubRaw, never> = {
    provider: "stub",
    target: TARGET,
    streamByDefault: false,
    prepareRequest(input: ExecuteInput<LanguageModelInput>): unknown {
      seen.push(input.targetInput.messages);
      return {};
    },
    send(): Promise<StubRaw> {
      return Promise.resolve({ text: "ok" });
    },
    async *openStream(): AsyncIterable<never> {},
    mapChunk(): readonly AdapterDelta[] {
      return [];
    },
    reconstructRaw(_accum: StreamAccumulatorView): StubRaw {
      return { text: "ok" };
    },
    normalize(raw: StubRaw): LanguageModelExecutionResult {
      return {
        specVersion: "2026-05-08",
        output: [{ type: "text", text: raw.text }],
        stopReason: "end",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    },
  };
  return { adapter, seen: () => seen };
}

async function makeExecutor(
  adapter: LanguageModelAdapter<StubRaw, never>,
  id: string,
): Promise<LanguageModelExecutor<StubRaw, never>> {
  const exec = new LanguageModelExecutor<StubRaw, never>(
    id,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    { adapter },
  );
  await exec.ready;
  return exec;
}

const execute = (
  exec: LanguageModelExecutor<StubRaw, never>,
  content: readonly LanguageModelMessage["content"][number][],
): Promise<unknown> =>
  exec.execute({
    targetInput: { messages: [{ role: "user", content } as LanguageModelMessage] },
    target: TARGET,
  });

const imageSources = (messages: readonly LanguageModelMessage[]): readonly string[] =>
  messages.flatMap((m) => m.content.flatMap((p) => (p.type === "image" ? [p.source.type] : [])));

describe("the screen runs before the adapter", () => {
  it("drops a declared-unprojectable source so prepareRequest never sees it", async () => {
    const { adapter, seen } = recordingAdapter();
    const exec = await makeExecutor(adapter, "exec-screen-1");
    await execute(exec, [
      textPart("what is this?"),
      imagePart({ type: "reference", fileId: "f-1" }),
    ]);
    expect(imageSources(seen()[0]!)).toEqual([]);
  });

  it("keeps a declared-carryable source", async () => {
    const { adapter, seen } = recordingAdapter();
    const exec = await makeExecutor(adapter, "exec-screen-2");
    await execute(exec, [imagePart({ type: "url", url: "gs://b/o" })]);
    expect(imageSources(seen()[0]!)).toEqual(["url"]);
  });

  it("never takes neighbouring text with the dropped part", async () => {
    const { adapter, seen } = recordingAdapter();
    const exec = await makeExecutor(adapter, "exec-screen-3");
    await execute(exec, [
      textPart("what is this?"),
      imagePart({ type: "reference", fileId: "f-1" }),
    ]);
    expect(seen()[0]![0]!.content.map((p) => p.type)).toEqual(["text"]);
  });
});

describe("the screen runs AFTER onBeforeModelGenerate — the regression that matters", () => {
  it("lets a hook resolve a `reference` source instead of losing it", async () => {
    // The documented way to handle an adopter file id: swap it for something the
    // provider accepts, at the generate seam. If the screen ran before that hook, the
    // part would already be gone and the resolver would have nothing to fix — and
    // nothing would fail, so nobody would notice the attachment stopped arriving.
    const { adapter, seen } = recordingAdapter();
    const exec = await makeExecutor(adapter, "exec-screen-4");

    // `exec.hooks.onBeforeModelGenerate`, and a returned value REPLACES the input
    // (`BeforeHook<In> = (input) => In | void`). Reaching for a non-existent
    // `exec.onBeforeModelGenerate?.()` silently registers nothing — which is how the
    // first draft of this test "passed" the wrong way and then failed correctly.
    const off = exec.hooks.onBeforeModelGenerate((input) => ({
      ...input,
      targetInput: {
        ...input.targetInput,
        messages: input.targetInput.messages.map((m) => ({
          ...m,
          content: m.content.map((p) =>
            p.type === "image" && p.source.type === "reference"
              ? imagePart({ type: "url", url: `gs://resolved/${p.source.fileId}` })
              : p,
          ),
        })),
      },
    }));

    await execute(exec, [imagePart({ type: "reference", fileId: "f-1" })]);
    off();

    // Survived, in the form the hook produced.
    expect(imageSources(seen()[0]!)).toEqual(["url"]);
    const resolved = seen()[0]![0]!.content[0]!;
    expect(resolved.type === "image" && resolved.source).toEqual({
      type: "url",
      url: "gs://resolved/f-1",
    });
  });

  it("still screens what the hook did NOT resolve", async () => {
    // The hook is a chance, not an exemption: whatever it leaves unprojectable is
    // still dropped rather than sent in a form the provider rejects.
    const { adapter, seen } = recordingAdapter();
    const exec = await makeExecutor(adapter, "exec-screen-5");

    const off = exec.hooks.onBeforeModelGenerate((input) => input); // resolves nothing

    await execute(exec, [textPart("hi"), imagePart({ type: "reference", fileId: "f-1" })]);
    off();
    expect(imageSources(seen()[0]!)).toEqual([]);
    expect(seen()[0]![0]!.content.map((p) => p.type)).toEqual(["text"]);
  });
});

describe("project() itself does not screen", () => {
  it("leaves an unprojectable source in the projected input", async () => {
    // Deliberate. `project` is a pure fold with its own hooks, and the request it
    // produces is not yet the request being sent — a hook downstream may still fix
    // it. Screening here would pre-empt that; screening happens at the wire instead.
    const { adapter } = recordingAdapter();
    const exec = await makeExecutor(adapter, "exec-screen-6");
    const projected = await exec.project({
      compiled: {
        specVersion: "2026-05-08",
        context: {
          entries: [
            {
              kind: "message",
              id: "m_1",
              role: "user",
              content: [{ type: "image", source: { type: "reference", fileId: "f-1" } }],
            },
          ],
        },
      } as never,
      target: TARGET,
      tools: [],
    });
    expect(imageSources(projected.messages)).toEqual(["reference"]);
  });
});

/** Collect bus events while `run` executes — `bus.subscribe` is a Stream, not a callback. */
async function collectLogs(bus: LocalEventBus, run: () => Promise<unknown>): Promise<unknown[]> {
  const collected: unknown[] = [];
  const fiber = Effect.runFork(
    Stream.runForEach(bus.subscribe({}), (e) =>
      Effect.sync(() => {
        if (e.name === "model:signal:log") collected.push(e.payload);
      }),
    ),
  );
  await new Promise((r) => setTimeout(r, 5));
  await run();
  await new Promise((r) => setTimeout(r, 10));
  await Effect.runPromise(Fiber.interrupt(fiber));
  return collected;
}

const declineLogs = (payloads: readonly unknown[]) =>
  payloads.filter(
    (p): p is { level: string; data: Record<string, unknown> } =>
      typeof p === "object" &&
      p !== null &&
      (p as { data?: { event?: string } }).data?.event === "model.media.declined",
  );

describe("a declined part is REPORTED, not merely droppable", () => {
  it("emits one warning per declined part, carrying the position that joins provenance", async () => {
    // The quietest failure in this layer: an attachment the target cannot carry is
    // dropped, the request SUCCEEDS, the model never saw it, and nothing marks it. Making
    // it auditable was not enough — an application only learns of it by asking. So it is
    // logged, on the surface every adopter already configures, with the coordinates a
    // reader joins to `buildMessageProvenance` to name the timeline entry.
    const { adapter } = recordingAdapter();
    const bus = new LocalEventBus();
    const exec = new LanguageModelExecutor<StubRaw, never>(
      "exec-screen-warn",
      new MemoryJournal(),
      bus,
      new LocalInbox(),
      { adapter },
    );
    await exec.ready;

    const logs = await collectLogs(bus, () =>
      execute(exec, [
        textPart("what is this?"),
        imagePart({ type: "reference", fileId: "019faa2c" }),
      ]),
    );

    const declines = declineLogs(logs);
    expect(declines).toHaveLength(1);
    expect(declines[0]!.level).toBe("warning");
    expect(declines[0]!.data).toMatchObject({
      provider: "stub",
      messageIndex: 0,
      partIndex: 1,
      partType: "image",
      sourceType: "reference",
    });
    expect(String(declines[0]!.data["reason"])).toContain("cannot carry");
  });

  it("says nothing when nothing is declined — the happy path pays no log", async () => {
    const { adapter } = recordingAdapter();
    const bus = new LocalEventBus();
    const exec = new LanguageModelExecutor<StubRaw, never>(
      "exec-screen-quiet",
      new MemoryJournal(),
      bus,
      new LocalInbox(),
      { adapter },
    );
    await exec.ready;
    const logs = await collectLogs(bus, () =>
      execute(exec, [imagePart({ type: "url", url: "gs://b/o" })]),
    );
    expect(declineLogs(logs)).toEqual([]);
  });
});
