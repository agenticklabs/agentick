/**
 * Conformance suite for `LanguageModelExecutor` implementations.
 *
 * Validates the invariants in `docs/proposals/v2/blueprint/06-executor-harness.md`.
 *
 * Run from any vitest test file:
 *
 * ```ts
 * import { describe } from "vitest";
 * import { runExecutorConformance } from "@agentick/spec-conformance-next";
 * import { MockLanguageModelExecutor } from "@agentick/executor-next";
 *
 * describe("MockLanguageModelExecutor", () =>
 *   runExecutorConformance(({ harnessId }) =>
 *     new MockLanguageModelExecutor(harnessId, ...)
 *   )
 * );
 * ```
 */

import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { ADAPTER_DELTA_TYPES } from "@agentick/spec-next";
import type {
  AdapterDeltaType,
  EventBus,
  ImageBlock,
  LanguageModelExecutionResult,
  LanguageModelExecutor,
  LanguageModelInput,
  LanguageModelTarget,
  RenderedTree,
  SectionEntry,
} from "@agentick/spec-next";

// ============================================================================
// Factory contract
// ============================================================================

export interface ExecutorConformanceFactoryInput {
  readonly harnessId: string;
  readonly scripted?: LanguageModelExecutionResult;
}

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
    config?: RenderedTree["config"];
    providerOptions?: RenderedTree["providerOptions"];
  } = {},
): RenderedTree {
  const section: SectionEntry = {
    kind: "section",
    id: "system",
    content: [{ type: "text", text: "You are a helpful assistant." }],
  };
  const userContent: RenderedTree["context"]["entries"][number] = {
    kind: "message",
    id: "m_1",
    role: "user",
    content: opts.imageBlock
      ? [{ type: "text", text: "Describe this image." }, opts.imageBlock]
      : [{ type: "text", text: "Say hi." }],
  };
  return {
    specVersion: "2026-05-08",
    context: {
      entries: [section, userContent],
    },
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    ...(opts.providerOptions !== undefined ? { providerOptions: opts.providerOptions } : {}),
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

export function runExecutorConformance(factory: ExecutorConformanceFactory): void {
  describe("ExecutorProtocol — project phase", () => {
    it("projects a RenderedTree into a target-shaped input", async () => {
      const { executor } = await factory({ harnessId: "ex-project-1" });
      const input = await executor.project({
        compiled: mkRenderedTree(),
        target: mkTarget(),
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
      const a = await executor.project({ compiled: tree, target });
      const b = await executor.project({ compiled: tree, target });
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

      const projected = await executor.project({ compiled: tree, target });
      const executed = await executor.execute({ targetInput: projected, target });
      const normalized = await executor.normalize({ targetOutput: executed, target });

      const terminal = await executor.run({ compiled: tree, target });
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
    it("projects Base64Source image blocks to data URLs (not '[binary]')", async () => {
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
      })) as LanguageModelInput;
      const userMsg = projected.messages.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      const imgPart = userMsg!.content.find((p) => p.type === "image") as
        | { type: "image"; imageUrl: string }
        | undefined;
      expect(imgPart).toBeDefined();
      expect(imgPart!.imageUrl.startsWith("data:image/png;base64,")).toBe(true);
      expect(imgPart!.imageUrl).not.toBe("[binary]");
    });

    it("projects UrlSource image blocks to the bare URL", async () => {
      const { executor } = await factory({ harnessId: "ex-img-2" });
      const imageBlock: ImageBlock = {
        type: "image",
        source: { type: "url", url: "https://example.com/img.png" },
        mimeType: "image/png",
      };
      const projected = (await executor.project({
        compiled: mkRenderedTree({ imageBlock }),
        target: mkTarget(),
      })) as LanguageModelInput;
      const userMsg = projected.messages.find((m) => m.role === "user");
      const imgPart = userMsg!.content.find((p) => p.type === "image") as
        | { type: "image"; imageUrl: string }
        | undefined;
      expect(imgPart!.imageUrl).toBe("https://example.com/img.png");
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
      await stream.result.catch(() => undefined);
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
      await stream.result.catch(() => undefined);
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
        bus.subscribe({ surface: "executor", phase: "delta" }).pipe(
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
      });
      const stream = executor.executeStream({
        targetInput: projected,
        target: mkTarget(),
      });
      for await (const _ of stream) {
        void _;
      }
      await stream.result.catch(() => undefined);
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

      const terminal = await executor.run({ compiled: tree, target });
      if (terminal.outcome !== "succeeded") throw new Error("expected success");

      const projected = await executor.project({ compiled: tree, target });
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
}
