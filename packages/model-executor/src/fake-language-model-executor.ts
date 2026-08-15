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
 *     via `emitDelta` so the streaming sim path stays cheap when
 *     nobody is listening.
 *   - `abort()` marks the named execution as aborted; the next `run`
 *     for that id fails with `ProviderAborted`. In-flight runs are
 *     interrupted via fiber when the substrate scope tears down.
 *
 * Provider adapters (Phase 4c) replace `execute` + `normalize`; the
 * harness shape stays identical.
 */

import { Effect, FiberRef } from "effect";
import {
  BaseHarness,
  OperationVeto,
  getContext,
  runHarnessProtocol,
  type StreamCommand,
  generateId,
} from "@agentick/runtime";
import type {
  AbortExecutorInput,
  AdapterDelta,
  EventBus,
  ExecuteErrorChannel,
  ExecuteInput,
  ExecutionTarget,
  TokenEstimate,
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
} from "@agentick/spec";
import {
  HandlerError,
  NormalizationFailed,
  ProjectionFailed,
  ProviderAborted,
  ProviderRejected,
  SPEC_VERSION,
} from "@agentick/spec";

import { omitUndefined } from "@agentick/utils";

import {
  buildMessages,
  buildParameters,
  buildTools,
  effectiveModelInfo,
  estimateTokenBreakdown,
} from "@agentick/model";
import {
  ExecutorLifecycle,
  isFoldedTerminal,
  operationOutcomeToTerminal,
  type ProviderRequestCall,
} from "./executor-lifecycle.js";
import { modelIdentityAttributes } from "./model-span-identity.js";

/**
 * The fake's twin of the real executor's `ProviderCallRef` — the per-call
 * context for its nested `model:provider-request` command (ADR 52 amendment
 * 2026-07-22). Same mechanism, so conformance for the nested op (parentOpId
 * threading, journal, abort) runs against the fake identically. Fiber-scoped;
 * module-shared is safe. The fake has no provider SDK, so its "raw chunk"
 * currency is the scripted {@link AdapterDelta} itself (no separate raw layer).
 */
const FakeProviderCallRef = FiberRef.unsafeMake<ProviderRequestCall | undefined>(undefined);

/** Read the per-call provider-request context; fail if invoked out of band. */
function readFakeProviderCall(): Effect.Effect<ProviderRequestCall, ExecuteErrorChannel> {
  return FiberRef.get(FakeProviderCallRef).pipe(
    Effect.flatMap((call) =>
      call === undefined
        ? Effect.fail<ExecuteErrorChannel>(
            new ProviderRejected({
              cause: new Error("model:provider-request invoked without a ProviderRequestCall"),
            }),
          )
        : Effect.succeed(call),
    ),
  );
}

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
  /**
   * Hold this run until the promise resolves — the scripted-timing knob for
   * race tests (an in-flight execution a concurrent send must join, an abort
   * arriving mid-run). The hold applies before the abort short-circuit, so an
   * abort during the hold still cancels.
   */
  readonly holdUntil?: Promise<void>;
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

  /**
   * Ledger of every projection this executor observed, in call order — the
   * canonical seen-input recorder for tests asserting on what reached the model
   * (the model-facing `tools` list, the `compiled` tree carrying
   * `config.responseFormat` / `config.toolChoice`).
   *
   * Recorded at the `project` command, which BOTH the streaming and
   * non-streaming paths cross — so a test reads `seenRuns[i].compiled` without
   * first having to force the loop off the path production takes. It used to
   * record in `run` only, which quietly made "assert what the model saw" and
   * "don't stream" the same decision.
   */
  readonly seenRuns: ProjectInput[] = [];

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
    opts?: { readonly origin?: import("@agentick/spec").OperationOrigin },
  ) => Promise<unknown>;
  private readonly modelGenerateStream: StreamCommand<
    ExecuteInput<LanguageModelInput>,
    AdapterDelta,
    unknown,
    ExecuteErrorChannel | SubstrateError
  >;

  /**
   * The nested provider-SDK call (ADR 52 amendment 2026-07-22) — the fake
   * mints it so the `model:provider-request` conformance (boundary hooks,
   * raw chunk hook, parentOpId threading, journal, abort) runs against the
   * fake exactly as against the real executor. Chunk = the scripted
   * {@link AdapterDelta} (the fake has no separate raw provider chunk layer).
   */
  private readonly modelProviderRequest: StreamCommand<
    unknown,
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
      ExecuteErrorChannel | SubstrateError
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
      ExecuteErrorChannel | SubstrateError
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
    // The nested provider-request command — parity with the real executor.
    this.modelProviderRequest = this.commandStream<
      unknown,
      AdapterDelta,
      unknown,
      ExecuteErrorChannel
    >({
      name: "model:provider-request",
      description: "the provider call (scripted)",
      exposure: "internal",
      body: (request, rawSink) => this.providerRequestBody(request, rawSink),
    });
  }

  private nextScripted(): MockScriptedRun | undefined {
    if (this.scriptedSequence.length === 0) return undefined;
    const entry =
      this.scriptedSequence[Math.min(this.scriptIndex, this.scriptedSequence.length - 1)];
    this.scriptIndex++;
    return entry;
  }

  /**
   * The current scripted entry WITHOUT advancing the cursor — the
   * `model:generate` command (via `generateBody`) is the single
   * cursor-advance for a run, so `runBody` peeks to read the run-path
   * bus deltas + the scripted `vetoed`/`canceled` short-circuit without
   * double-consuming.
   */
  private peekScripted(): MockScriptedRun | undefined {
    if (this.scriptedSequence.length === 0) return undefined;
    return this.scriptedSequence[Math.min(this.scriptIndex, this.scriptedSequence.length - 1)];
  }

  /**
   * Shares the real {@link import("./language-model-executor.js").LanguageModelExecutor}
   * span-identity contract via {@link modelIdentityAttributes} — one source, so
   * the double's spans can't drift from the real executor's.
   */
  protected override spanAttributes(
    op: Operation<unknown, unknown, unknown>,
  ): Readonly<Record<string, unknown>> {
    return { ...super.spanAttributes(op), ...modelIdentityAttributes(op) };
  }

  // ──────── ExecutorProtocol ────────

  private projectFx(
    input: ProjectInput,
  ): Effect.Effect<LanguageModelInput, ProjectionError | SubstrateError, never> {
    const op: Operation<ProjectInput, LanguageModelInput, ProjectionError> = {
      opId: `model:project:${generateId()}`,
      surface: "model",
      name: "model:command:project",
      scope: input.scope ?? {},
      input,
    };
    this.seenRuns.push(input);
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

  /**
   * Measure a projection, the same arithmetic the real executor runs.
   *
   * A fake that omits this makes the estimate invisible to every integration
   * test — which is how the lifecycle bridge this file's sibling gate exists to
   * protect shipped dead across five packages. The fake projects for real, so
   * it can measure for real.
   */
  estimateInput(input: LanguageModelInput, target?: ExecutionTarget): TokenEstimate {
    const info = effectiveModelInfo(target ?? this.target);
    return estimateTokenBreakdown(input, ...(info ? [{ info }] : []));
  }

  execute(input: ExecuteInput<LanguageModelInput>): Promise<unknown> {
    // Edge facade over the `model:generate` command.
    const executionId = input.scope?.executionId ?? `exec:${generateId()}`;
    return this.modelGenerate({ ...input, scope: { ...(input.scope ?? {}), executionId } });
  }

  executeStream(input: ExecuteInput<LanguageModelInput>): ExecutorStream<unknown> {
    // Edge facade = the `.stream` (AsyncStream) face of the `model:generate_stream`
    // command. Boundary hooks + terminal + bus deltas fire exactly as the real
    // executor's do.
    const executionId = input.scope?.executionId ?? `exec:${generateId()}`;
    return this.modelGenerateStream.stream({
      ...input,
      scope: { ...(input.scope ?? {}), executionId },
    });
  }

  private normalizeFx(
    input: NormalizeInput<unknown>,
  ): Effect.Effect<LanguageModelExecutionResult, NormalizeError | SubstrateError, never> {
    const op: Operation<NormalizeInput<unknown>, LanguageModelExecutionResult, NormalizeError> = {
      opId: `model:normalize:${generateId()}`,
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
      ...super.fx,
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
    const executionId = input.scope?.executionId ?? `exec:${generateId()}`;
    // opId is per-tick, not per-execution — the same executor.run may be
    // called many times within one execution (multi-tick loops). Using
    // executionId alone would make the substrate's idempotency replay
    // the first tick's terminal on every subsequent tick.
    const tickId = input.scope?.tickId;
    const opId =
      tickId !== undefined
        ? `model:run:${executionId}:${tickId}`
        : `model:run:${executionId}:${generateId()}`;
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
    const executionId = input.scope?.executionId ?? `exec:${generateId()}`;
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
   * shape {@link emitDelta} needs for bus parity. `sink` is `null` for
   * `model:generate` (non-streaming — returns the scripted raw) and the real
   * delta sink for `model:generate_stream` (replays the scripted deltas to the
   * sink AND the bus). A scripted `outcome: "failed"` fails the run — driving the
   * loop's streaming/non-streaming failure path.
   */
  private generateBody(
    input: ExecuteInput<LanguageModelInput>,
    sink: ((delta: AdapterDelta) => Effect.Effect<void>) | null,
  ): Effect.Effect<unknown, ExecuteErrorChannel | SubstrateError, never> {
    return Effect.gen(this, function* () {
      const ctx = yield* getContext;
      const opName = sink !== null ? "model:command:generate_stream" : "model:command:generate";
      const op: Operation<unknown, unknown> = {
        opId: ctx.opId ?? `${opName}:${generateId()}`,
        surface: "model",
        name: opName,
        ...(ctx.parentOpId !== undefined ? { parentOpId: ctx.parentOpId } : {}),
        scope: input.scope ?? {},
        input,
      };
      // The fake's "native request" is the projected input — it has no SDK
      // params. Invoke the nested provider-request command in-fiber (parentOpId
      // auto-threads), seeding the per-call context on the FiberRef.
      const call: ProviderRequestCall = { execInput: input, deltaSink: sink, op };
      return yield* this.modelProviderRequest
        .fx(input.targetInput, () => Effect.void)
        .pipe(Effect.locally(FakeProviderCallRef, call));
    });
  }

  /**
   * The fake's `model:provider-request` body — replays the scripted deltas.
   * Mirrors the real executor's split: `rawSink` is the command's own chunk
   * sink (`onModelProviderRequestChunk` wraps it); `call.deltaSink` is the
   * outer `model:generate_stream` AdapterDelta sink; `call.op` is the identity
   * bus deltas are attributed to. Advancing the scripted cursor here keeps the
   * generate command the single cursor-advance per run.
   */
  private providerRequestBody(
    _request: unknown,
    rawSink: (chunk: AdapterDelta) => Effect.Effect<void>,
  ): Effect.Effect<unknown, ExecuteErrorChannel, never> {
    return Effect.gen(this, function* () {
      const ctx = yield* getContext;
      const call = yield* readFakeProviderCall();
      const input = call.execInput;
      const sink = call.deltaSink;
      const op = call.op;
      const executionId = input.scope?.executionId ?? ctx.executionId ?? `exec:${generateId()}`;
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
          const scriptedDeltas: ReadonlyArray<AdapterDelta> =
            next?.deltas ?? defaultDeltasFor(scriptedResult);
          for (const delta of scriptedDeltas) {
            // Raw chunk hook path (fake's chunk currency = the AdapterDelta).
            yield* rawSink(delta);
            yield* sink(delta);
            // Bus parity — observability subscribers see the same deltas.
            yield* this.emitDelta(op, delta).pipe(Effect.catchAll(() => Effect.void));
          }
        }
        // Scripted non-success outcomes are raised HERE — the one point both
        // the streaming and non-streaming paths cross — so a script means the
        // same thing on either. Each rides the signal the real thing would use,
        // and the loop folds all three back into terminals.
        switch (next?.outcome) {
          case "failed":
            return yield* Effect.fail(new ProviderRejected({ cause: "scripted stream failure" }));
          case "canceled":
            return yield* Effect.fail(new ProviderAborted({ reason: "scripted cancel" }));
          case "vetoed":
            return yield* Effect.fail(new OperationVeto("scripted veto") as never);
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
  ): Effect.Effect<
    ExecutorTerminal<LanguageModelExecutionResult>,
    ExecutorError | SubstrateError,
    never
  > {
    return Effect.gen(this, function* () {
      // PEEK (don't consume) the scripted entry — the `model:generate`
      // command is the single cursor-advance for the execute step below;
      // run needs the entry only for bus-delta observability + the
      // scripted vetoed/canceled short-circuit.
      const next = this.peekScripted();

      // 1. project — through the COMMAND, same as the streaming path. A fake
      //    that projects out-of-band is a fake whose `model:command:project`
      //    hooks fire on one path and not the other.
      const projected = yield* this.projectFx(input);

      // 2. Emit scripted deltas (if any) for bus observability.
      //    The loop's streaming path uses `executeStream` directly,
      //    not run, so this is the observability-only mirror.
      const deltas = next?.deltas;
      if (deltas && deltas.length > 0) {
        for (const delta of deltas) {
          yield* this.emitDelta(op, delta).pipe(Effect.orDie);
        }
      }

      // 2b. Scripted hold — park the run until the test releases it (race
      //     tests: steer-join, mid-run abort). Deliberately BEFORE the abort
      //     short-circuit so an abort during the hold still cancels.
      if (next?.holdUntil !== undefined) {
        yield* Effect.promise(() => next.holdUntil!);
      }

      // 3. Pre-execute abort short-circuit.
      if (this.lifecycle.isAborted(executionId)) {
        return { outcome: "canceled", reason: "aborted" };
      }

      // 4. execute — route through the `model:generate` COMMAND (ADR 89 §1)
      //    so a NON-STREAMING run fires `onBefore/AfterModelGenerate` +
      //    `guardGenerate` (the streaming path rides `model:generate_stream`
      //    the same way, via `executeStreamFx`). `commandEffect` composes the
      //    cascade IN THIS FIBER, so `parentOpId` threads + interruption
      //    propagates. The command consumes the scripted entry.
      const executeInput: ExecuteInput<LanguageModelInput> = {
        targetInput: projected,
        target: input.target,
        scope: { ...(input.scope ?? {}), executionId },
        ...omitUndefined({ signal: input.signal }),
      };
      const raw = yield* this.commandEffect<
        ExecuteInput<LanguageModelInput>,
        unknown,
        ExecuteErrorChannel
      >("model:generate", executeInput).pipe(
        // A mid-flight provider abort folds to a canceled terminal.
        Effect.catchTag("ProviderAborted", (e) =>
          Effect.succeed<ExecutorTerminal<LanguageModelExecutionResult>>({
            outcome: "canceled",
            reason: e.reason ?? "aborted",
          }),
        ),
        // Scripted `outcome: "failed"` surfaces from `generateBody` as a
        // ProviderRejected — the fake maps it to a FAILED terminal (drives
        // the loop's failure path) rather than rejecting `run()`.
        Effect.catchTag("ProviderRejected", (e) =>
          Effect.succeed<ExecutorTerminal<LanguageModelExecutionResult>>({
            outcome: "failed",
            error: e,
          }),
        ),
        // A `guardGenerate` veto at the command boundary folds to the
        // matching executor terminal; deferred / failed-replay re-raise.
        Effect.catchTag("OperationOutcomeError", (e) => {
          const terminal = operationOutcomeToTerminal(e);
          return terminal !== undefined ? Effect.succeed(terminal) : Effect.fail(e);
        }),
      );

      // A fold above returned a terminal directly — pass it through.
      if (isFoldedTerminal(raw)) {
        return raw;
      }

      // 6. normalize (identity for the mock).
      return {
        outcome: "succeeded",
        result: {
          ...(raw as LanguageModelExecutionResult),
          estimate: this.estimateInput(projected, input.target),
        },
      };
    });
  }
}

// ============================================================================
// Pure helpers
// ============================================================================

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
// / `messagePartFromBlock`) live in
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
