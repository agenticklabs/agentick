/**
 * Conformance suite for `LanguageModelExecutor` implementations.
 *
 * Validates the invariants in `docs/proposals/v2/blueprint/06-executor-harness.md`.
 *
 * Run from any vitest test file:
 *
 * ```ts
 * import { describe } from "vitest";
 * import { runExecutorConformance } from "@agentick/spec-conformance";
 * import { FakeLanguageModelExecutor } from "@agentick/model-executor";
 *
 * describe("FakeLanguageModelExecutor", () =>
 *   runExecutorConformance(({ harnessId }) =>
 *     new FakeLanguageModelExecutor(harnessId, ...)
 *   )
 * );
 * ```
 */

import { omitUndefined } from "@agentick/utils";

import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { ADAPTER_DELTA_TYPES } from "@agentick/spec";
import { drainRejection } from "@agentick/utils/testing";
import type {
  AdapterDeltaType,
  ContentBlock,
  EventBus,
  ExecuteError,
  ImageBlock,
  MediaSourceKind,
  MediaSupport,
  LanguageModelExecutionResult,
  LanguageModelExecutor,
  LanguageModelInput,
  LanguageModelTarget,
  RenderedTree,
  MediaSource,
} from "@agentick/spec";

// ============================================================================
// Factory contract
// ============================================================================

export interface ExecutorConformanceFactoryInput {
  readonly harnessId: string;
  readonly scripted?: LanguageModelExecutionResult;
  /**
   * When present, the factory MUST build the executor over a client whose
   * provider call throws this value — whichever of the streaming and
   * non-streaming calls the adapter makes.
   */
  readonly throws?: unknown;
}

/**
 * Provider-native error fixtures, one entry per {@link ExecuteError} class:
 * shapes this executor's classification MUST resolve to that class, or
 * `"not-applicable"` when it classifies nothing to that class today.
 *
 * Required, total, and keyed off the tag union, so adding a class to the
 * taxonomy breaks every adapter's conformance file at compile time — the
 * taxonomy propagates itself (ADR 99, Verification). `mapProviderError` stays
 * optional at runtime; this is where silence becomes a decision.
 */
export type ExecutorErrorFixtures = {
  readonly [Tag in ExecuteError["_tag"]]: readonly unknown[] | "not-applicable";
};

/**
 * Construct an executor for a single conformance test. Returning the
 * executor AND the bus the executor was wired with lets the suite
 * subscribe to delta envelopes for the streaming-path tests.
 *
 * Adapters that don't expose their internal bus can return a fresh
 * `LocalEventBus` they never write to — the bus-related assertion
 * will skip if the executor's run produces no envelopes.
 */
export type ExecutorConformanceFactory = (
  input: ExecutorConformanceFactoryInput,
) => Promise<{ executor: LanguageModelExecutor; bus: EventBus }>;

// ============================================================================
// Fixtures
// ============================================================================

const SPEC_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function mkRenderedTree(
  opts: {
    imageBlock?: ImageBlock;
    /** Any modality block — the media-support probe drives all four. */
    mediaBlock?: ContentBlock;
    config?: RenderedTree["config"];
    providerOptions?: RenderedTree["providerOptions"];
  } = {},
): RenderedTree {
  // ADR 94: a section is content, not an entry — a `<Section>` inside
  // `<System>` arrives here already lowered into the system message's blocks,
  // with the section id stamped on each produced block.
  const system: RenderedTree["context"]["entries"][number] = {
    kind: "message",
    role: "system",
    id: "system",
    content: [{ type: "text", text: "You are a helpful assistant.", id: "system" }],
  };
  const media = opts.mediaBlock ?? opts.imageBlock;
  const userContent: RenderedTree["context"]["entries"][number] = {
    kind: "message",
    id: "m_1",
    role: "user",
    content: media
      ? [{ type: "text", text: "Describe this image." }, media]
      : [{ type: "text", text: "Say hi." }],
  };
  return {
    specVersion: "2026-05-08",
    context: {
      entries: [system, userContent],
    },
    ...omitUndefined({ config: opts.config, providerOptions: opts.providerOptions }),
  };
}

function mkTarget(): LanguageModelTarget {
  return {
    kind: "language-model",
    provider: "mock",
    modelId: "mock-v1",
    capabilities: {
      supportsTools: true,
      supportsStreaming: true,
      contextWindow: 8192,
      maxOutputTokens: 1024,
    },
  };
}

function mkScripted(text = "hi"): LanguageModelExecutionResult {
  return {
    specVersion: "2026-05-08",
    output: [{ type: "text", text }],
    stopReason: "end",
    usage: { inputTokens: 8, outputTokens: 1, totalTokens: 9 },
  };
}

// ============================================================================
// Suite
// ============================================================================

export function runExecutorConformance(
  factory: ExecutorConformanceFactory,
  errorFixtures: ExecutorErrorFixtures,
): void {
  describe("ExecutorProtocol — project phase", () => {
    it("projects a RenderedTree into a target-shaped input", async () => {
      const { executor } = await factory({ harnessId: "ex-project-1" });
      const input = await executor.project({
        compiled: mkRenderedTree(),
        target: mkTarget(),
        tools: [],
      });
      expect(input).toBeDefined();
      const messages = (input as { messages?: ReadonlyArray<unknown> }).messages;
      expect(Array.isArray(messages)).toBe(true);
      expect((messages as ReadonlyArray<unknown>).length).toBeGreaterThan(0);
    });

    it("project is deterministic for the same inputs", async () => {
      const { executor } = await factory({ harnessId: "ex-project-2" });
      const tree = mkRenderedTree();
      const target = mkTarget();
      const a = await executor.project({ compiled: tree, target, tools: [] });
      const b = await executor.project({ compiled: tree, target, tools: [] });
      expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
    });
  });

  describe("ExecutorProtocol — run convenience", () => {
    it("returns ExecutorTerminal{outcome: 'succeeded'} on the happy path", async () => {
      const scripted = mkScripted("hello");
      const { executor } = await factory({ harnessId: "ex-run-1", scripted });
      const terminal = await executor.run({
        compiled: mkRenderedTree(),
        target: mkTarget(),
        tools: [],
      });
      expect(terminal.outcome).toBe("succeeded");
      if (terminal.outcome === "succeeded") {
        expect(terminal.result.specVersion).toMatch(SPEC_VERSION_PATTERN);
        expect(terminal.result.output).toBeDefined();
        expect(terminal.result.stopReason).toBeDefined();
      }
    });

    it("succeeded result.output is an array of content blocks", async () => {
      const { executor } = await factory({ harnessId: "ex-run-2", scripted: mkScripted() });
      const terminal = await executor.run({
        compiled: mkRenderedTree(),
        target: mkTarget(),
        tools: [],
      });
      if (terminal.outcome !== "succeeded") throw new Error("expected success");
      expect(Array.isArray(terminal.result.output)).toBe(true);
      for (const block of terminal.result.output) {
        expect(typeof block.type).toBe("string");
      }
    });
  });

  describe("ExecutorProtocol — abort", () => {
    it("abort with an unknown executionId is a no-op", async () => {
      const { executor } = await factory({ harnessId: "ex-abort-1" });
      await expect(executor.abort({ executionId: "no-such-execution" })).resolves.toBeUndefined();
    });
  });

  describe("ExecutorProtocol — phase isolation", () => {
    it("normalize on prior-execute output produces the same ExecutionResult as run", async () => {
      const scripted = mkScripted("phase-iso");
      const { executor } = await factory({ harnessId: "ex-iso-1", scripted });
      const tree = mkRenderedTree();
      const target = mkTarget();

      const projected = await executor.project({ compiled: tree, target, tools: [] });
      const executed = await executor.execute({ targetInput: projected, target });
      const normalized = await executor.normalize({ targetOutput: executed, target });

      const terminal = await executor.run({ compiled: tree, target, tools: [] });
      if (terminal.outcome !== "succeeded") throw new Error("expected success");

      const phaseText = normalized.output
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      const runText = terminal.result.output
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      expect(phaseText).toEqual(runText);
    });
  });

  // ============================================================================
  // Parity contract — behaviors every v2 adapter MUST surface to match v1.
  // Each new adapter must pass these; see docs/proposals/v2/V1-PARITY-TRACKER.md
  // for the per-gap traceability.
  // ============================================================================

  describe("ExecutorProtocol parity — base64 image source (G4)", () => {
    it("carries a Base64Source image through structurally", async () => {
      const { executor } = await factory({ harnessId: "ex-img-1" });
      const imageBlock: ImageBlock = {
        type: "image",
        source: {
          type: "base64",
          data: "iVBORw0KGgo=", // dummy PNG header
          mimeType: "image/png",
        },
        mimeType: "image/png",
      };
      const projected = (await executor.project({
        compiled: mkRenderedTree({ imageBlock }),
        target: mkTarget(),
        tools: [],
      })) as LanguageModelInput;
      const userMsg = projected.messages.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      const imgPart = userMsg!.content.find((p) => p.type === "image") as
        | { type: "image"; source: MediaSource }
        | undefined;
      expect(imgPart).toBeDefined();
      // The SOURCE survives, structurally. This used to assert a `data:` URL string,
      // because the canonical part carried `imageUrl: string` — and that flattening is
      // what destroyed any source with no lexical form (an adopter `reference` became a
      // bare file id before any adapter saw it). Asserting the source is strictly
      // stronger: it pins that nothing was lost, not merely that one case round-trips.
      expect(imgPart!.source).toEqual({
        type: "base64",
        data: "iVBORw0KGgo=",
        mimeType: "image/png",
      });
    });

    it("projects UrlSource image blocks without flattening the source", async () => {
      const { executor } = await factory({ harnessId: "ex-img-2" });
      const imageBlock: ImageBlock = {
        type: "image",
        source: { type: "url", url: "https://example.com/img.png" },
        mimeType: "image/png",
      };
      const projected = (await executor.project({
        compiled: mkRenderedTree({ imageBlock }),
        target: mkTarget(),
        tools: [],
      })) as LanguageModelInput;
      const userMsg = projected.messages.find((m) => m.role === "user");
      const imgPart = userMsg!.content.find((p) => p.type === "image") as
        | { type: "image"; source: MediaSource }
        | undefined;
      expect(imgPart!.source).toEqual({ type: "url", url: "https://example.com/img.png" });
    });

    it("carries a REFERENCE source through untouched — the case flattening destroyed", async () => {
      // The regression this whole change exists for. `{ type: "reference", fileId }` is
      // an adopter's own id; the framework cannot resolve it and must not invent a form
      // for it. Flattened, it arrived at every provider as a bare uuid typed as a URL,
      // and Vertex answered "the fileUri parameter must be a Cloud Storage or HTTP(S)
      // URI but the entered value was '019faa2c-…'".
      //
      // Deterministic rejection against a durable timeline entry, so every later turn
      // resent it and failed identically — one attachment made a conversation
      // permanently unusable. The source reaching the adapter INTACT is what lets an
      // app resolve it (at the `onModelGenerate` seam) or an adapter decline it.
      const { executor } = await factory({ harnessId: "ex-img-3" });
      const imageBlock: ImageBlock = {
        type: "image",
        source: { type: "reference", fileId: "019faa2c-5506-7000-b8ea-3c63628e4c89" },
        mimeType: "image/png",
      };
      const projected = (await executor.project({
        compiled: mkRenderedTree({ imageBlock }),
        target: mkTarget(),
        tools: [],
      })) as LanguageModelInput;
      const imgPart = projected.messages
        .find((m) => m.role === "user")!
        .content.find((p) => p.type === "image") as
        | { type: "image"; source: MediaSource }
        | undefined;
      expect(imgPart!.source).toEqual({
        type: "reference",
        fileId: "019faa2c-5506-7000-b8ea-3c63628e4c89",
      });
    });
  });

  // ==========================================================================
  // The media-support declaration — the part checkable WITHOUT the wire.
  //
  // `capabilities.media` states which `MediaSource` kinds a target carries per
  // modality, and the executor enforces it immediately before `prepareRequest`
  // (see `screenMedia`). Whether a DECLARATION matches an adapter's real wire
  // projection can only be checked against the provider-native request, which is
  // provider-shaped and therefore not visible from a generic suite — that check
  // lives in `runMediaDeclarationCheck`, which each adapter package runs with its
  // own "does this request carry a part of this modality" predicate.
  //
  // What IS generic is coherence between the declaration and the older, coarser
  // `supportsVision` boolean. Two fields answering overlapping questions is exactly
  // where drift hides, and no type can catch a target that claims vision while
  // declaring no image kinds.
  // ==========================================================================

  describe("ExecutorProtocol — media declaration coherence", () => {
    it("agrees with supportsVision, in both directions", async () => {
      const { executor } = await factory({ harnessId: "ex-media-coherence" });
      const capabilities = executor.target.capabilities;
      const media: MediaSupport | undefined = capabilities?.media;
      if (media === undefined || capabilities?.supportsVision === undefined) return;
      const carriesImages = (media.image ?? []).length > 0;
      expect(carriesImages).toBe(capabilities.supportsVision);
    });

    it("declares no source kind outside the MediaSource union", async () => {
      // Types cover a literal declaration; this covers one built dynamically or cast,
      // where a typo becomes a modality that silently carries nothing.
      const { executor } = await factory({ harnessId: "ex-media-kinds" });
      const media: MediaSupport | undefined = executor.target.capabilities?.media;
      if (media === undefined) return;
      const known: readonly MediaSourceKind[] = ["base64", "url", "reference"];
      // Only the MODALITY keys hold source kinds. `urlSchemes` sits in the same object
      // and holds URI schemes, so iterating `Object.values` blindly would assert that
      // "https" is a MediaSource kind — which it is not, and which is how this test
      // failed the moment `urlSchemes` landed.
      const modalities = ["image", "document", "audio", "video"] as const;
      for (const modality of modalities) {
        for (const kind of media[modality] ?? []) expect(known).toContain(kind);
      }
      for (const scheme of media.urlSchemes ?? []) {
        expect(scheme).not.toContain(":"); // a scheme, not a URI prefix
        expect(scheme).toBe(scheme.toLowerCase());
      }
    });
  });

  describe("ExecutorProtocol parity — sampling params (G1)", () => {
    it("threads SpecConfig sampling params into the projected input", async () => {
      const { executor } = await factory({ harnessId: "ex-params-1" });
      const projected = (await executor.project({
        compiled: mkRenderedTree({
          config: { temperature: 0.42, maxOutputTokens: 256 },
        }),
        target: mkTarget(),
        tools: [],
      })) as LanguageModelInput;
      // Whichever convention the adapter uses (parameters.* field, or
      // some equivalent), the canonical projection MUST expose them.
      // Default projections produce `parameters` on the LanguageModelInput.
      // Custom adapters that map elsewhere can override this test.
      if (projected.parameters !== undefined) {
        expect(projected.parameters.temperature).toBe(0.42);
        expect(projected.parameters.maxOutputTokens).toBe(256);
      }
    });
  });

  describe("ExecutorProtocol parity — providerOptions (G5)", () => {
    it("preserves canonical projection when target.providerOptions is set", async () => {
      const { executor } = await factory({ harnessId: "ex-popts-1" });
      // The adapter MAY use, ignore, or pass through provider keys, but
      // must not drop the canonical `messages` projection when
      // providerOptions is present. The actual spread-into-request is
      // adapter-specific and covered by provider tests.
      const target = {
        ...mkTarget(),
        providerOptions: { unknownProvider: { x: 1 } } as never,
      };
      const projected = (await executor.project({
        compiled: mkRenderedTree(),
        target,
        tools: [],
      })) as LanguageModelInput;
      expect(Array.isArray(projected.messages)).toBe(true);
    });
  });

  describe("ExecutorProtocol parity — executeStream surface (G6)", () => {
    it("executeStream is implemented", async () => {
      const { executor } = await factory({ harnessId: "ex-stream-0" });
      expect(typeof executor.executeStream).toBe("function");
    });

    it("returns an AsyncIterable + .result + .abort", async () => {
      const scripted = mkScripted("stream-shape");
      const { executor } = await factory({
        harnessId: "ex-stream-1",
        scripted,
      });
      if (!executor.executeStream) throw new Error("executeStream not implemented");
      const projected = await executor.project({
        compiled: mkRenderedTree(),
        target: mkTarget(),
        tools: [],
      });
      const stream = executor.executeStream({
        targetInput: projected,
        target: mkTarget(),
      });
      expect(typeof stream[Symbol.asyncIterator]).toBe("function");
      expect(stream.result).toBeDefined();
      expect(typeof stream.abort).toBe("function");
      for await (const _ of stream) {
        void _;
      }
      await drainRejection(stream.result);
    });

    it("every yielded delta has a valid AdapterDelta type", async () => {
      const scripted = mkScripted("delta-types");
      const { executor } = await factory({
        harnessId: "ex-stream-2",
        scripted,
      });
      if (!executor.executeStream) throw new Error("executeStream not implemented");
      const projected = await executor.project({
        compiled: mkRenderedTree(),
        target: mkTarget(),
        tools: [],
      });
      const stream = executor.executeStream({
        targetInput: projected,
        target: mkTarget(),
      });
      const knownTypes = new Set<AdapterDeltaType>(ADAPTER_DELTA_TYPES);
      let seenAny = false;
      for await (const delta of stream) {
        seenAny = true;
        expect(knownTypes.has(delta.type)).toBe(true);
      }
      await drainRejection(stream.result);
      expect(seenAny).toBe(true);
    });

    it("emits at least one bus envelope on the streaming path", async () => {
      const scripted = mkScripted("bus-mirror");
      const { executor, bus } = await factory({
        harnessId: "ex-stream-3",
        scripted,
      });
      if (!executor.executeStream) throw new Error("executeStream not implemented");

      const collected: unknown[] = [];
      Effect.runFork(
        bus.subscribe({ surface: "model", phase: "delta" }).pipe(
          Stream.tap((evt) =>
            Effect.sync(() => {
              collected.push(evt);
            }),
          ),
          Stream.runDrain,
        ),
      );
      await new Promise((r) => setImmediate(r));

      const projected = await executor.project({
        compiled: mkRenderedTree(),
        target: mkTarget(),
        tools: [],
      });
      const stream = executor.executeStream({
        targetInput: projected,
        target: mkTarget(),
      });
      for await (const _ of stream) {
        void _;
      }
      await drainRejection(stream.result);
      await new Promise((r) => setTimeout(r, 50));

      expect(collected.length).toBeGreaterThan(0);
    });

    it("stream .result resolves with a value matching run() output", async () => {
      const scripted = mkScripted("result-match");
      const { executor } = await factory({
        harnessId: "ex-stream-4",
        scripted,
      });
      if (!executor.executeStream) throw new Error("executeStream not implemented");
      const tree = mkRenderedTree();
      const target = mkTarget();

      const terminal = await executor.run({ compiled: tree, target, tools: [] });
      if (terminal.outcome !== "succeeded") throw new Error("expected success");

      const projected = await executor.project({ compiled: tree, target, tools: [] });
      const stream = executor.executeStream({ targetInput: projected, target });
      for await (const _ of stream) {
        void _;
      }
      const raw = await stream.result;
      const normalized = await executor.normalize({ targetOutput: raw, target });
      const runText = terminal.result.output
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      const streamText = normalized.output
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      expect(streamText).toBe(runText);
    });
  });

  // ============================================================================
  // ADR 89 §1 — the command-ified model call. `execute` is the `model:generate`
  // command; `executeStream` the `model:generate_stream` command. Every
  // conformant executor is a BaseHarness, so the model call rides the ONE
  // interceptor cascade: the derived `onBefore/AfterModelGenerate[Stream]` hooks
  // + `.guard` (`guardGenerate`) apply to it, and its lifecycle envelopes carry
  // `model:*` op names (the pre-1B `executor:*` surface is gone).
  // ============================================================================

  describe("ExecutorProtocol — command-ified model call (ADR 89 §1)", () => {
    // The interceptor surface every conformant executor inherits from
    // BaseHarness. The registry augmentation that types the model verbs lives in
    // the executor package (not here), so the hook keys are supplied untyped.
    interface Interceptable {
      hook(config: Record<string, unknown>): () => void;
      guard(decide: (input: unknown, ctx: unknown) => unknown): () => void;
    }
    const interceptable = (e: LanguageModelExecutor): Interceptable =>
      e as unknown as Interceptable;

    it("execute() mints model:generate — onBefore sees the input, onAfter the result", async () => {
      const { executor } = await factory({ harnessId: "ex-cmd-1", scripted: mkScripted("cmd") });
      let beforeInput: unknown;
      let afterOutput: unknown;
      const off = interceptable(executor).hook({
        onBeforeModelGenerate: (input: unknown) => {
          beforeInput = input;
        },
        onAfterModelGenerate: (output: unknown) => {
          afterOutput = output;
        },
      });
      const projected = await executor.project({
        compiled: mkRenderedTree(),
        target: mkTarget(),
        tools: [],
      });
      await executor.execute({ targetInput: projected, target: mkTarget() });
      off();
      // onBefore observed the ExecuteInput (carries `targetInput`); onAfter the raw.
      expect(beforeInput).toBeDefined();
      expect((beforeInput as { targetInput?: unknown }).targetInput).toBeDefined();
      expect(afterOutput).toBeDefined();
    });

    it("guardGenerate: a veto rejects execute() before the provider runs (project untouched)", async () => {
      const { executor } = await factory({ harnessId: "ex-cmd-2", scripted: mkScripted() });
      // Veto ONLY the model call — its input is the ExecuteInput (has
      // `targetInput`), unlike project/normalize/run — so `project()` still runs.
      const off = interceptable(executor).guard((input) =>
        input !== null && typeof input === "object" && "targetInput" in input
          ? { kind: "veto", reason: "locked" }
          : undefined,
      );
      const projected = await executor.project({
        compiled: mkRenderedTree(),
        target: mkTarget(),
        tools: [],
      });
      await expect(
        executor.execute({ targetInput: projected, target: mkTarget() }),
      ).rejects.toBeTruthy();
      off();
    });

    it("executeStream yields the iterator + fires onAfterModelGenerateStream at the terminal", async () => {
      const { executor } = await factory({
        harnessId: "ex-cmd-3",
        scripted: mkScripted("streamed"),
      });
      if (!executor.executeStream) throw new Error("executeStream not implemented");
      let afterFired = false;
      const off = interceptable(executor).hook({
        onAfterModelGenerateStream: (o: unknown) => {
          afterFired = true;
          return o;
        },
      });
      const projected = await executor.project({
        compiled: mkRenderedTree(),
        target: mkTarget(),
        tools: [],
      });
      const stream = executor.executeStream({ targetInput: projected, target: mkTarget() });
      expect(typeof stream[Symbol.asyncIterator]).toBe("function");
      for await (const _ of stream) {
        void _;
      }
      await drainRejection(stream.result);
      off();
      // onAfter fired once at the terminal — AFTER the iterator drained.
      expect(afterFired).toBe(true);
    });

    it("onModelGenerateStreamChunk taps each streamed chunk (ADR 80 Phase 2 sink-wrap)", async () => {
      const { executor } = await factory({
        harnessId: "ex-cmd-chunk",
        scripted: mkScripted("chunked"),
      });
      if (!executor.executeStream) throw new Error("executeStream not implemented");
      const seen: unknown[] = [];
      const off = interceptable(executor).hook({
        onModelGenerateStreamChunk: {
          observe: (chunk: unknown) => {
            seen.push(chunk);
          },
        },
      });
      const projected = await executor.project({
        compiled: mkRenderedTree(),
        target: mkTarget(),
        tools: [],
      });
      const stream = executor.executeStream({ targetInput: projected, target: mkTarget() });
      const drained: unknown[] = [];
      for await (const d of stream) drained.push(d);
      await drainRejection(stream.result);
      off();
      // The interceptor SINK-WRAPS the stream: it tapped exactly the chunks the
      // iterator drained, in the same order.
      expect(seen).toEqual(drained);
      expect(seen.length).toBeGreaterThan(0);
    });

    it("run() (non-streaming) composes through model:generate — onBefore/onAfter fire on a run tick", async () => {
      // ADR 89 §1: the NON-STREAMING `run` composes project → the
      // `model:generate` command → normalize, so the command's boundary
      // hooks fire on a plain `run()` (no `executeStream`), exactly as they
      // do on the streaming path — this is what the §4 lifecycle projection
      // (`useOnModelGenerateStart/End`) rides on a non-streaming tick.
      const { executor } = await factory({
        harnessId: "ex-cmd-run-1",
        scripted: mkScripted("run-cmd"),
      });
      let beforeInput: unknown;
      let afterOutput: unknown;
      const off = interceptable(executor).hook({
        onBeforeModelGenerate: (input: unknown) => {
          beforeInput = input;
        },
        onAfterModelGenerate: (output: unknown) => {
          afterOutput = output;
        },
      });
      const terminal = await executor.run({
        compiled: mkRenderedTree(),
        target: mkTarget(),
        tools: [],
      });
      off();
      expect(terminal.outcome).toBe("succeeded");
      // onBefore observed the ExecuteInput (carries `targetInput`); onAfter the raw.
      expect((beforeInput as { targetInput?: unknown } | undefined)?.targetInput).toBeDefined();
      expect(afterOutput).toBeDefined();
    });

    it("guardGenerate: a veto on a non-streaming run yields a vetoed TERMINAL (provider never runs)", async () => {
      // A guard vetoes the `model:generate` command; `run` folds the
      // command-boundary veto into a `vetoed` executor terminal (run's
      // contract is a terminal, not a rejection) — the loop pattern-matches
      // the non-success outcome. Vetoing by the ExecuteInput shape leaves
      // project/normalize untouched.
      const { executor } = await factory({ harnessId: "ex-cmd-run-2", scripted: mkScripted() });
      const off = interceptable(executor).guard((input) =>
        input !== null && typeof input === "object" && "targetInput" in input
          ? { kind: "veto", reason: "locked" }
          : undefined,
      );
      const terminal = await executor.run({
        compiled: mkRenderedTree(),
        target: mkTarget(),
        tools: [],
      });
      off();
      expect(terminal.outcome).toBe("vetoed");
    });

    it("lifecycle envelopes carry model:* op names — the executor:* surface is gone", async () => {
      const { executor, bus } = await factory({ harnessId: "ex-cmd-4", scripted: mkScripted() });
      const names: string[] = [];
      Effect.runFork(
        bus.subscribe({ surface: "model" }).pipe(
          Stream.tap((e) => Effect.sync(() => names.push(e.name))),
          Stream.runDrain,
        ),
      );
      await new Promise((r) => setImmediate(r));
      const projected = await executor.project({
        compiled: mkRenderedTree(),
        target: mkTarget(),
        tools: [],
      });
      await executor.execute({ targetInput: projected, target: mkTarget() });
      await new Promise((r) => setTimeout(r, 50));
      // The model call minted a `model:command:generate` op...
      expect(names.some((n) => n === "model:command:generate")).toBe(true);
      // ...and NOTHING carries the pre-1B `executor:*` op surface.
      expect(names.every((n) => !n.startsWith("executor:"))).toBe(true);
    });
  });

  // ==========================================================================
  // ADR 99 — the taxonomy, asserted END-TO-END. A fixture is thrown from the
  // stub client and the assertion reads the `_tag` off the EXECUTOR's
  // rejection, so it covers the adapter's `mapProviderError`, the executor's
  // fallback table, and the pass-through between them — not the mapping
  // function in isolation, which can be right while the wiring is not.
  // ==========================================================================

  const declaredEntries = Object.entries(errorFixtures);
  const unclassified = declaredEntries
    .filter(([, fixtures]) => fixtures === "not-applicable")
    .map(([tag]) => tag);
  const classified = declaredEntries.filter(
    (entry): entry is [string, readonly unknown[]] => entry[1] !== "not-applicable",
  );

  describe("ExecutorProtocol — provider-error classification (ADR 99)", () => {
    for (const tag of unclassified) {
      it.skip(`${tag}: this executor classifies nothing to it`, () => {});
    }

    for (const [tag, fixtures] of classified) {
      it(`${tag}: declares at least one fixture`, () => {
        expect(fixtures.length).toBeGreaterThan(0);
      });

      fixtures.forEach((fixture, index) => {
        it(`${tag}: classifies provider fixture #${index}`, async () => {
          const { executor } = await factory({
            harnessId: `ex-err-${tag}-${index}`,
            throws: fixture,
          });
          const projected = await executor.project({
            compiled: mkRenderedTree(),
            target: mkTarget(),
            tools: [],
          });
          await expect(
            executor.execute({ targetInput: projected, target: mkTarget() }),
          ).rejects.toMatchObject({ _tag: tag });
        });
      });
    }
  });
}
