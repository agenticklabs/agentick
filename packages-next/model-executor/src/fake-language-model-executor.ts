/**
 * `FakeLanguageModelExecutor` — reference implementation of
 * `LanguageModelExecutor` for tests, examples, and the v2 substrate
 * proof. Inherits from `BaseHarness<"model">` for the full phase
 * contract + FiberRef scope + lazy delta emission.
 *
 * Behavior:
 *   - `project()` folds the rendered tree's `context.entries` into
 *     canonical `LanguageModelMessage[]` and includes declared tools
 *     filtered to `exposure.includes("model")`.
 *   - `execute()` consumes the optional `scripted` result configured at
 *     construction. If `scripted.stream` is supplied, it emits delta
 *     envelopes per chunk before returning the accumulated output.
 *     Without scripting, returns a default "ok" reply.
 *   - `normalize()` is the identity transform for the mock — it returns
 *     the scripted result as-is. Real adapters parse provider response
 *     shapes here.
 *   - `run()` composes project → execute → normalize, emitting deltas
 *     via `emitDeltaLazy` so the streaming sim path stays cheap when
 *     nobody is listening.
 *   - `abort()` marks the named execution as aborted; the next `run`
 *     for that id fails with `ProviderAborted`. In-flight runs are
 *     interrupted via fiber when the substrate scope tears down.
 *
 * Provider adapters (Phase 4c) replace `execute` + `normalize`; the
 * harness shape stays identical.
 */

import { Effect } from "effect";
import {
  BaseHarness,
  getContext,
  runHarnessProtocol,
  type StreamCommand,
  ulid,
} from "@agentick/runtime-next";
import type {
  AbortExecutorInput,
  AdapterDelta,
  EventBus,
  ExecuteErrorChannel,
  ExecuteInput,
  ExecutionTarget,
  ExecutorError,
  ExecutorFx,
  ExecutorStream,
  ExecutorTerminal,
  LanguageModelExecutionResult,
  LanguageModelExecutor,
  LanguageModelInput,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  NormalizeError,
  NormalizeInput,
  Operation,
  OperationJournal,
  ProjectInput,
  ProjectionError,
  RunInput,
  SubstrateError,
} from "@agentick/spec-next";
import {
  HandlerError,
  NormalizationFailed,
  ProjectionFailed,
  ProviderAborted,
  ProviderRejected,
  SPEC_VERSION,
} from "@agentick/spec-next";

import { buildMessages, buildParameters, buildTools } from "@agentick/model-next";
import { ExecutorLifecycle } from "./executor-lifecycle.js";

// ============================================================================
// Construction options
// ============================================================================

export interface MockScriptedRun {
  /** The terminal result the mock executor returns from a `run` call. */
  readonly result: LanguageModelExecutionResult;
  /**
   * Optional ordered `AdapterDelta` events the mock emits via
   * `executeStream`. Each entry is yielded in order; `.result`
   * resolves with the scripted `result` after the last delta.
   * When omitted, `executeStream` synthesizes a sensible default
   * (message-start → content-start → content-delta(joined text) →
   * content-end → content(block) → message-end → message) from the
   * scripted result.
   */
  readonly deltas?: ReadonlyArray<AdapterDelta>;
  /**
   * Override the run's terminal outcome. Default (omitted) → `"succeeded"`
   * with `result`. `"failed"` / `"vetoed"` / `"canceled"` return the
   * corresponding non-success terminal — so tests can drive loop failure-path
   * behavior without a bespoke executor stub. (Abort-driven cancellation still
   * goes through `abort()` / the lifecycle; this is the *scripted* variant.)
   */
  readonly outcome?: "failed" | "vetoed" | "canceled";
}

export interface FakeLanguageModelExecutorOptions {
  /**
   * Scripted outcome for `run`. Accepts either a single scripted run
   * (every `run()` returns the same result) or an array of scripted
   * runs consumed in order — the i-th `run()` returns the i-th entry.
   * After the array is exhausted, subsequent calls reuse the last
   * entry. Without this, the executor returns a minimal `"hi"` reply
   * with `stopReason: "end"`.
   */
  readonly scripted?: MockScriptedRun | ReadonlyArray<MockScriptedRun>;
  /**
   * Self-described target. Defaults to a generic
   * `{ kind: "language-model", provider: "mock", modelId: "mock-v1" }`
   * with tool + streaming capabilities. Provider adapters supply their
   * own derived target; tests can override here.
   */
  readonly target?: ExecutionTarget;
}

// ============================================================================
// Internals
// ============================================================================

const DEFAULT_REPLY: LanguageModelExecutionResult = {
  specVersion: SPEC_VERSION,
  output: [{ type: "text", text: "hi" }],
  stopReason: "end",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

// ============================================================================
// FakeLanguageModelExecutor
// ============================================================================

const DEFAULT_MOCK_TARGET: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

export class FakeLanguageModelExecutor
  extends BaseHarness<"model">
  implements LanguageModelExecutor
{
  readonly family = "language-model" as const;
  readonly target: ExecutionTarget;

  private readonly scriptedSequence: ReadonlyArray<MockScriptedRun>;
  private scriptIndex = 0;
  private readonly lifecycle = new ExecutorLifecycle();

  /**
   * The command-ified provider call (ADR 89 §1) — the fake mirrors the real
   * {@link import("./language-model-executor.js").LanguageModelExecutor} surface
   * EXACTLY (a Meszaros fake typed against the executor protocol): `execute`
   * is the `model:generate` command, `executeStream` the `model:generate_stream`
   * streaming command. Declaring them mints `onBefore/AfterModelGenerate[Stream]`
   * + `guardGenerate` + journaling on the model call, so the fake passes the
   * same conformance as the real executor.
   */
  private readonly modelGenerate: (
    input: ExecuteInput<LanguageModelInput>,
    opts?: { readonly origin?: import("@agentick/spec-next").OperationOrigin },
  ) => Promise<unknown>;
  private readonly modelGenerateStream: StreamCommand<
    ExecuteInput<LanguageModelInput>,
    AdapterDelta,
    unknown,
    ExecuteErrorChannel
  >;

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: FakeLanguageModelExecutorOptions = {},
  ) {
    super("model", scopeId, journal, bus, inbox);
    this.target = options.target ?? DEFAULT_MOCK_TARGET;
    this.scriptedSequence = options.scripted
      ? Array.isArray(options.scripted)
        ? options.scripted
        : [options.scripted as MockScriptedRun]
      : [];

    // Command-ify the provider call (ADR 89 §1), matching the real executor.
    this.modelGenerate = this.command<
      ExecuteInput<LanguageModelInput>,
      unknown,
      ExecuteErrorChannel
    >({
      name: "model:generate",
      description: "the non-streaming provider call (scripted)",
      scope: (input) => input.scope ?? {},
      handler: (input) => this.generateBody(input, null),
    });
    this.modelGenerateStream = this.commandStream<
      ExecuteInput<LanguageModelInput>,
      AdapterDelta,
      unknown,
      ExecuteErrorChannel
    >({
      name: "model:generate_stream",
      description: "the streaming provider call (scripted)",
      scope: (input) => input.scope ?? {},
      body: (input, sink) => this.generateBody(input, sink),
      stream: {
        // Parity with the real executor: a ProviderAborted completes the
        // iterator cleanly rather than throwing.
        isCancellation: (cause) => cause instanceof ProviderAborted,
      },
    });
  }

  private nextScripted(): MockScriptedRun | undefined {
    if (this.scriptedSequence.length === 0) return undefined;
    const entry =
      this.scriptedSequence[Math.min(this.scriptIndex, this.scriptedSequence.length - 1)];
    this.scriptIndex++;
    return entry;
  }

  // ──────── ExecutorProtocol ────────

  private projectFx(
    input: ProjectInput,
  ): Effect.Effect<LanguageModelInput, ProjectionError | SubstrateError, never> {
    const op: Operation<ProjectInput, LanguageModelInput, ProjectionError> = {
      opId: `model:project:${ulid()}`,
      surface: "model",
      name: "model:command:project",
      scope: input.scope ?? {},
      input,
    };
    return this.runOperation(op, (i) =>
      Effect.try({
        try: () => projectImpl(i),
        catch: (cause): ProjectionError =>
          new ProjectionFailed({ reason: "projection threw", cause }),
      }),
    );
  }

  project(input: ProjectInput): Promise<LanguageModelInput> {
    return runHarnessProtocol(this.projectFx(input));
  }

  execute(input: ExecuteInput<LanguageModelInput>): Promise<unknown> {
    // Edge facade over the `model:generate` command.
    const executionId = input.scope?.executionId ?? `exec:${ulid()}`;
    return this.modelGenerate({ ...input, scope: { ...(input.scope ?? {}), executionId } });
  }

  executeStream(input: ExecuteInput<LanguageModelInput>): ExecutorStream<unknown> {
    // Edge facade = the `.stream` (AsyncStream) face of the `model:generate_stream`
    // command. Boundary hooks + terminal + bus deltas fire exactly as the real
    // executor's do.
    const executionId = input.scope?.executionId ?? `exec:${ulid()}`;
    return this.modelGenerateStream.stream({
      ...input,
      scope: { ...(input.scope ?? {}), executionId },
    });
  }

  private normalizeFx(
    input: NormalizeInput<unknown>,
  ): Effect.Effect<LanguageModelExecutionResult, NormalizeError | SubstrateError, never> {
    const op: Operation<NormalizeInput<unknown>, LanguageModelExecutionResult, NormalizeError> = {
      opId: `model:normalize:${ulid()}`,
      surface: "model",
      name: "model:command:normalize",
      scope: input.scope ?? {},
      input,
    };
    // normalize is independent of the run-sequence cursor — it just
    // identity-transforms whatever was passed in (matching what a real
    // adapter would do parsing a provider response).
    return this.runOperation(op, (i) =>
      Effect.try({
        try: () => normalizeImpl(i, this.scriptedSequence[0]),
        catch: (cause): NormalizeError => new NormalizationFailed({ cause }),
      }),
    );
  }

  normalize(input: NormalizeInput<unknown>): Promise<LanguageModelExecutionResult> {
    return runHarnessProtocol(this.normalizeFx(input));
  }

  /**
   * The Effect-canonical `.fx` surface (ADR 77) — mirrors the real
   * `LanguageModelExecutor`. `fx.run` exposes the run Effect un-run;
   * `fx.executeStream` is the sink-fold twin over the scripted deltas.
   */
  get fx(): ExecutorFx<LanguageModelInput, unknown, LanguageModelExecutionResult> {
    return {
      use: (mw) => this.registerEffectMiddleware(mw),
      run: (input) => this.runFx(input),
      project: (input) => this.projectFx(input),
      normalize: (input) => this.normalizeFx(input),
      executeStream: (input, sink) => this.executeStreamFx(input, sink),
    };
  }

  private runFx(
    input: RunInput,
  ): Effect.Effect<
    ExecutorTerminal<LanguageModelExecutionResult>,
    ExecutorError | SubstrateError,
    never
  > {
    const executionId = input.scope?.executionId ?? `exec:${ulid()}`;
    // opId is per-tick, not per-execution — the same executor.run may be
    // called many times within one execution (multi-tick loops). Using
    // executionId alone would make the substrate's idempotency replay
    // the first tick's terminal on every subsequent tick.
    const tickId = input.scope?.tickId;
    const opId =
      tickId !== undefined
        ? `model:run:${executionId}:${tickId}`
        : `model:run:${executionId}:${ulid()}`;
    const op: Operation<RunInput, ExecutorTerminal<LanguageModelExecutionResult>, ExecutorError> = {
      opId,
      surface: "model",
      name: "model:command:run",
      scope: { ...(input.scope ?? {}), executionId },
      input,
    };
    return this.runOperation(op, (i) => this.runBody(i, executionId, op));
  }

  /**
   * Sink-fold streaming twin — the `.fx` face of the `model:generate_stream`
   * command. Composes in the caller's fiber; the command cascade (guard +
   * `onBefore/AfterModelGenerateStream`) wraps the {@link generateBody} run.
   * This is the form the loop's per-tick model call consumes.
   */
  private executeStreamFx(
    input: ExecuteInput<LanguageModelInput>,
    sink: (delta: AdapterDelta) => Effect.Effect<void>,
  ): Effect.Effect<unknown, ExecuteErrorChannel | SubstrateError, never> {
    const executionId = input.scope?.executionId ?? `exec:${ulid()}`;
    return this.modelGenerateStream.fx(
      { ...input, scope: { ...(input.scope ?? {}), executionId } },
      sink,
    );
  }

  run(input: RunInput): Promise<ExecutorTerminal<LanguageModelExecutionResult>> {
    return runHarnessProtocol(this.runFx(input));
  }

  abort(input: AbortExecutorInput): Promise<void> {
    return runHarnessProtocol(
      Effect.sync(() => this.lifecycle.abortExecution(input.executionId, input.reason)),
    );
  }

  // ──────── inbox dispatch ────────

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(
      new HandlerError({
        cause: new Error("executor inbox dispatch not yet wired (Phase 4b minimum)"),
      }),
    );
  }

  // ──────── internals ────────

  /**
   * The shared `model:generate[_stream]` command body (ADR 89 §1). Runs INSIDE
   * the command cascade, so the ambient {@link RuntimeContext} carries this op's
   * `opId` / `parentOpId` / scope — rebuilt here into the {@link Operation}
   * shape {@link emitDeltaLazy} needs for bus parity. `sink` is `null` for
   * `model:generate` (non-streaming — returns the scripted raw) and the real
   * delta sink for `model:generate_stream` (replays the scripted deltas to the
   * sink AND the bus). A scripted `outcome: "failed"` fails the run — driving the
   * loop's streaming/non-streaming failure path.
   */
  private generateBody(
    input: ExecuteInput<LanguageModelInput>,
    sink: ((delta: AdapterDelta) => Effect.Effect<void>) | null,
  ): Effect.Effect<unknown, ExecuteErrorChannel, never> {
    return Effect.gen(this, function* () {
      const ctx = yield* getContext;
      const executionId = input.scope?.executionId ?? ctx.executionId ?? `exec:${ulid()}`;
      if (this.lifecycle.isAborted(executionId)) {
        return yield* Effect.fail<ExecuteErrorChannel>(
          new ProviderAborted({ reason: "aborted prior to execute" }),
        );
      }
      this.lifecycle.register({ executionId });
      try {
        const next = this.nextScripted();
        const scriptedResult = next?.result ?? DEFAULT_REPLY;
        if (sink !== null) {
          const opName = "model:command:generate_stream";
          const streamOp: Operation<ExecuteInput<LanguageModelInput>, unknown> = {
            opId: ctx.opId ?? `${opName}:${ulid()}`,
            surface: "model",
            name: opName,
            ...(ctx.parentOpId !== undefined ? { parentOpId: ctx.parentOpId } : {}),
            scope: input.scope ?? {},
            input,
          };
          const scriptedDeltas: ReadonlyArray<AdapterDelta> =
            next?.deltas ?? defaultDeltasFor(scriptedResult);
          for (const delta of scriptedDeltas) {
            yield* sink(delta);
            // Bus parity — observability subscribers see the same deltas.
            yield* this.emitDeltaLazy(streamOp, () => delta).pipe(
              Effect.catchAll(() => Effect.void),
            );
          }
        }
        if (next?.outcome === "failed") {
          return yield* Effect.fail(new ProviderRejected({ cause: "scripted stream failure" }));
        }
        return scriptedResult as unknown;
      } finally {
        this.lifecycle.unregister(executionId);
      }
    });
  }

  private runBody(
    input: RunInput,
    executionId: string,
    op: Operation<RunInput, ExecutorTerminal<LanguageModelExecutionResult>>,
  ): Effect.Effect<ExecutorTerminal<LanguageModelExecutionResult>, ExecutorError, never> {
    return Effect.gen(this, function* () {
      // Snapshot the next scripted run for this invocation. Subsequent
      // calls advance the sequence cursor in `nextScripted()`.
      const next = this.nextScripted();

      // 1. project
      const projected = yield* projectAsEffect(input);

      // 2. Emit scripted deltas (if any) for bus observability.
      //    The loop's streaming path uses `executeStream` directly,
      //    not run, so this is the observability-only mirror.
      const deltas = next?.deltas;
      if (deltas && deltas.length > 0) {
        for (const delta of deltas) {
          yield* this.emitDeltaLazy(op, () => delta).pipe(Effect.orDie);
        }
      }

      // 3. execute
      if (this.lifecycle.isAborted(executionId)) {
        const terminal: ExecutorTerminal<LanguageModelExecutionResult> = {
          outcome: "canceled",
          reason: "aborted",
        };
        return terminal;
      }
      // Scripted non-success outcome (failure-path driving).
      switch (next?.outcome) {
        case "failed":
          return { outcome: "failed", error: new ProviderRejected({ cause: "scripted failure" }) };
        case "vetoed":
          return { outcome: "vetoed", reason: "scripted veto" };
        case "canceled":
          return { outcome: "canceled", reason: "scripted cancel" };
      }
      const targetOutput = next?.result ?? DEFAULT_REPLY;
      void projected;

      // 4. normalize (identity for mock)
      const result: LanguageModelExecutionResult = targetOutput;
      const terminal: ExecutorTerminal<LanguageModelExecutionResult> = {
        outcome: "succeeded",
        result,
      };
      return terminal;
    });
  }
}

// ============================================================================
// Pure helpers
// ============================================================================

function projectAsEffect(input: RunInput): Effect.Effect<LanguageModelInput, never, never> {
  return Effect.sync(() =>
    projectImpl({
      compiled: input.compiled,
      target: input.target,
      tools: input.tools,
      ...(input.narrate !== undefined ? { narrate: input.narrate } : {}),
    }),
  );
}

function projectImpl(input: ProjectInput): LanguageModelInput {
  const messages = buildMessages(input.compiled);
  const tools = buildTools(input.tools, input.narrate);
  const parameters = buildParameters(input.compiled);
  return {
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...(parameters !== undefined ? { parameters } : {}),
  };
}

function normalizeImpl(
  input: NormalizeInput<unknown>,
  scripted: MockScriptedRun | undefined,
): LanguageModelExecutionResult {
  // The mock's execute returned `LanguageModelExecutionResult` directly;
  // normalize is identity. A real adapter would parse `input.targetOutput`
  // shaped as the provider response.
  const out = input.targetOutput;
  if (isLanguageModelExecutionResult(out)) return out;
  return scripted?.result ?? DEFAULT_REPLY;
}

function isLanguageModelExecutionResult(v: unknown): v is LanguageModelExecutionResult {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { stopReason?: unknown; output?: unknown };
  return typeof o.stopReason === "string" && Array.isArray(o.output);
}

// Projection helpers (`buildMessages` / `buildTools` / `buildParameters`
// / `collectSectionText` / `messagePartFromBlock`) live in
// `canonical-projection.ts`. This executor uses them as-is — no
// fake-specific tweaks.

/**
 * Synthesize a sensible default `AdapterDelta` stream for a scripted
 * result when the caller didn't supply explicit deltas. Mirrors what a
 * naive real adapter would emit: message-start → content-start →
 * content-delta(full text) → content-end → content(block) →
 * message-end → message.
 */
function defaultDeltasFor(result: LanguageModelExecutionResult): readonly AdapterDelta[] {
  const out: AdapterDelta[] = [{ type: "message-start", role: "assistant" }];
  let blockIndex = 0;
  for (const block of result.output) {
    if (block.type === "text") {
      out.push({ type: "content-start", blockIndex, blockType: "text" });
      out.push({ type: "content-delta", blockIndex, delta: block.text });
      out.push({ type: "content-end", blockIndex });
      out.push({ type: "content", blockIndex, content: block });
    } else {
      // Non-text blocks (image, tool_use, etc.) — emit just the
      // start/end + summary, no delta (no streaming text).
      out.push({
        type: "content-start",
        blockIndex,
        blockType: block.type as never,
      });
      out.push({ type: "content-end", blockIndex });
      out.push({ type: "content", blockIndex, content: block });
    }
    blockIndex += 1;
  }
  for (const tc of result.toolCalls ?? []) {
    out.push({
      type: "tool-call",
      callId: tc.id,
      name: tc.name,
      input: tc.input as Readonly<Record<string, unknown>>,
    });
  }
  const usage = result.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  out.push({ type: "message-end", stopReason: result.stopReason, usage });
  out.push({
    type: "message",
    message: { role: "assistant", content: result.output },
    stopReason: result.stopReason,
    usage,
  });
  return out;
}
