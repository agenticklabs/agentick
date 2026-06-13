/**
 * `BaseLanguageModelExecutor<TRaw>` — abstract intermediate class for
 * first-party provider executors.
 *
 * Sits between `BaseHarness<"executor">` (substrate phase contract,
 * FiberRef scope, OTel spans, lazy delta emission) and the concrete
 * provider impls (`OpenAIExecutor`, `AnthropicExecutor`,
 * `GoogleExecutor`, `AISDKExecutor`, plus any third-party adopter
 * provider). Owns ~500 LOC of framework scaffolding that was duplicated
 * across the four shipped providers:
 *
 *   - `project` / `execute` / `executeStream` / `normalize` / `run` /
 *     `abort` envelope shapes + Operation construction
 *   - In-flight tracking (`inFlight: Map`, `aborted: Set`,
 *     `InFlightEntry`)
 *   - The shared `executeStream` iterator queue + resolver + bus-emit
 *     plumbing
 *   - The `runBody` skeleton (project → execute → postProcess →
 *     normalize → terminal wrap)
 *   - Default `projectImpl` (canonical RenderedTree fold)
 *   - Default `mapProviderError` + `isAbortError`
 *   - Default `handleMessage` stub
 *
 * Subclasses fill in provider-specific hooks: `buildParams`,
 * `callProvider`, `drainStream`, `normalizeRaw`, plus optional
 * `postProcessForNormalize` for tag-router-style mutations and
 * `isAbortError` for SDKs that throw non-standard abort error types.
 *
 * Adopters writing a one-off model integration should use the
 * callback-style `defineExecutor` factory instead — that surface is
 * shaped for the simple case (single async `run` callback returning
 * the normalized result). This base is for adapters that need to
 * preserve the raw provider response type for telemetry / replay /
 * provider-specific introspection.
 *
 * @see docs/proposals/v2/blueprint/06-executor-harness.md
 */

import { Effect } from "effect";

import { BaseHarness, runHarnessProtocol, ulid } from "@agentick/runtime-next";
import type {
  AbortExecutorInput,
  AdapterDelta,
  EventBus,
  ExecuteError,
  ExecuteInput,
  ExecutionTarget,
  ExecutorError,
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
} from "@agentick/spec-next";

import { defaultProject } from "./canonical-projection.js";

// Re-export so consumers of the base module can grab the canonical
// projection without a second import line.
export { defaultProject } from "./canonical-projection.js";

// ============================================================================
// Stream context — what subclasses see during `drainStream`
// ============================================================================

/**
 * Context passed to `drainStream`. The subclass owns the chunk loop
 * (provider APIs differ too much for a single per-chunk hook); the
 * base owns delta routing.
 */
export interface StreamContext {
  /**
   * Merged abort signal. Subclasses pass this to their provider SDK so
   * abort() calls propagate.
   */
  readonly signal: AbortSignal;
  /**
   * Emit an `AdapterDelta`. The base routes it to:
   *   1. The bus (via `emitDeltaLazy`) for observability subscribers.
   *   2. The active `executeStream` iterator (when present) so consumers
   *      iterating the stream get deltas as they arrive.
   * Fire-and-forget; never throws.
   */
  readonly emit: (delta: AdapterDelta) => void;
  /** The execution id (always populated). */
  readonly executionId: string;
}

// ============================================================================
// Internals
// ============================================================================

interface InFlightEntry {
  readonly executionId: string;
  abort?: AbortController;
  abortReason?: string;
}

// ============================================================================
// BaseLanguageModelExecutor
// ============================================================================

export abstract class BaseLanguageModelExecutor<TRaw>
  extends BaseHarness<"executor">
  implements LanguageModelExecutor
{
  readonly family = "language-model" as const;
  abstract readonly target: ExecutionTarget;

  /**
   * Whether `execute()` (the non-iterating entry point) should still
   * use the streaming provider call internally to drive bus-level
   * `executor:delta` envelopes. Default: false (call the non-streaming
   * provider API). Subclasses override at construction.
   */
  protected readonly streamByDefault: boolean = false;

  /**
   * Whether this provider supports the streaming codepath at all. AI
   * SDK's `streamText` is its own surface (separate from
   * `generateText`); when `false`, the base throws if a caller hits
   * `executeStream`. Default: true.
   */
  protected readonly supportsRunStreaming: boolean = true;

  private readonly inFlight = new Map<string, InFlightEntry>();
  private readonly aborted = new Set<string>();

  constructor(scopeId: string, journal: OperationJournal, bus: EventBus, inbox: MessageInbox) {
    super("executor", scopeId, journal, bus, inbox);
  }

  // ──────────────────────────────────────────────────────────────────
  // Required hooks — subclass MUST implement
  // ──────────────────────────────────────────────────────────────────

  /**
   * Translate canonical `LanguageModelInput` → provider request shape.
   * Examples:
   *   - OpenAI: `LanguageModelInput → ChatCompletionCreateParams`
   *   - Anthropic: `LanguageModelInput → MessageCreateParams`
   *   - Google: `LanguageModelInput → GenerateContentParameters`
   *
   * Pure. May read `target.providerOptions` for per-provider knobs.
   */
  protected abstract buildParams(input: LanguageModelInput, target: ExecutionTarget): unknown;

  /**
   * Non-streaming provider call. Returns the raw provider response.
   * Subclasses propagate `signal` to the SDK so abort works.
   *
   * Throws on provider error; base translates via `mapProviderError`.
   */
  protected abstract callProvider(params: unknown, signal: AbortSignal | undefined): Promise<TRaw>;

  /**
   * Streaming provider call. Subclasses:
   *   1. Open the provider stream (passing `ctx.signal`).
   *   2. Iterate chunks.
   *   3. Per chunk, map to `AdapterDelta`(s) and call `ctx.emit(...)` for each.
   *   4. Assemble the final raw response and return it.
   *
   * The base owns the queue/resolver/bus-emit plumbing; the subclass
   * owns the loop + per-chunk → delta translation (provider APIs vary
   * enough that a single per-chunk hook doesn't fit).
   *
   * Override `supportsRunStreaming = false` if your provider has no
   * streaming surface.
   */
  protected abstract drainStream(params: unknown, ctx: StreamContext): Promise<TRaw>;

  /**
   * Convert raw provider response → canonical
   * `LanguageModelExecutionResult`. Called from `normalize()` and from
   * `runBody` (after `postProcessForNormalize`).
   */
  protected abstract normalizeRaw(raw: TRaw): LanguageModelExecutionResult;

  // ──────────────────────────────────────────────────────────────────
  // Optional hooks — sensible defaults; override when needed
  // ──────────────────────────────────────────────────────────────────

  /**
   * Project `ProjectInput` → `LanguageModelInput`. Default is the
   * canonical RenderedTree fold (system text from sections + messages
   * + declared tools filtered to `model` exposure).
   *
   * Override when the provider needs a different system-message shape
   * (e.g., Anthropic preserves per-section `providerMetadata` for
   * `cache_control` by emitting one text part per system section).
   */
  protected projectImpl(input: ProjectInput): LanguageModelInput {
    return defaultProject(input);
  }

  /**
   * Mutate the raw response between `execute` and `normalize` in the
   * `run` codepath. Used by OpenAI/Anthropic/Google for the tag-router
   * (`parseThinkTags` / `customBlocks`) which rewrites the message
   * content before normalization extracts reasoning blocks. Default:
   * identity.
   */
  protected postProcessForNormalize(raw: TRaw): TRaw {
    return raw;
  }

  /**
   * Default abort-detection: matches `AbortError` (Web/Node) and
   * `APIUserAbortError` (OpenAI/Anthropic SDK convention) plus any
   * error message containing "abort". Override for SDKs with
   * non-standard abort signaling.
   */
  protected isAbortError(cause: unknown): boolean {
    if (!(cause instanceof Error)) return false;
    return (
      cause.name === "AbortError" ||
      cause.name === "APIUserAbortError" ||
      /abort/i.test(cause.message)
    );
  }

  /**
   * Default provider-error mapping: AbortError → `ProviderAborted`;
   * any error with a numeric `status` / `statusCode` field →
   * `ProviderRejected`; everything else → `StreamFailed`. Override
   * when your provider surfaces structured errors you can extract more
   * detail from.
   */
  protected mapProviderError(cause: unknown): ExecuteError {
    if (this.isAbortError(cause)) {
      return {
        _tag: "ProviderAborted",
        reason: cause instanceof Error ? cause.message : "aborted",
      };
    }
    const status =
      (cause as { status?: unknown })?.status ?? (cause as { statusCode?: unknown })?.statusCode;
    if (typeof status === "number") {
      return {
        _tag: "ProviderRejected",
        status,
        cause,
      };
    }
    return { _tag: "StreamFailed", cause };
  }

  /**
   * Default inbox handler — fails with a `HandlerError`. Override only
   * if your provider executor responds to async inbox messages (none
   * of the shipped four do yet).
   */
  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail({
      _tag: "HandlerError",
      cause: new Error(`${this.constructor.name} inbox dispatch not yet wired`),
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // ExecutorProtocol — framework-final, do not override in subclasses
  // ──────────────────────────────────────────────────────────────────

  project(input: ProjectInput): Promise<LanguageModelInput> {
    const op: Operation<ProjectInput, LanguageModelInput> = {
      opId: `executor:project:${ulid()}`,
      surface: "executor",
      name: "executor:command:project",
      scope: input.scope ?? {},
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.try({
          try: () => this.projectImpl(i),
          catch: (cause): ProjectionError => ({
            _tag: "ProjectionFailed",
            reason: "projection threw",
            cause,
          }),
        }),
      ),
    );
  }

  execute(input: ExecuteInput<LanguageModelInput>): Promise<unknown> {
    const executionId = input.scope?.executionId ?? `exec:${ulid()}`;
    const op: Operation<ExecuteInput<LanguageModelInput>, unknown> = {
      opId: `executor:execute:${executionId}:${ulid()}`,
      surface: "executor",
      name: "executor:command:execute",
      scope: input.scope ?? { executionId },
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        this.executeBody(i, executionId, op as Operation<unknown, unknown>, null),
      ),
    );
  }

  executeStream(input: ExecuteInput<LanguageModelInput>): ExecutorStream<TRaw> {
    if (!this.supportsRunStreaming) {
      const err: ExecuteError = {
        _tag: "StreamFailed",
        cause: new Error(
          `${this.constructor.name} does not support executeStream — use execute() instead`,
        ),
      };
      const resultPromise: Promise<TRaw> = Promise.reject(err);
      // Silence Node's unhandled-rejection — the caller may not await .result.
      resultPromise.catch(() => {});
      return {
        result: resultPromise,
        abort: () => {},
        [Symbol.asyncIterator]() {
          return {
            next: () => Promise.reject(err),
            return: () =>
              Promise.resolve({ value: undefined as unknown as AdapterDelta, done: true }),
          };
        },
      };
    }

    const executionId = input.scope?.executionId ?? `exec:${ulid()}`;
    const queue: AdapterDelta[] = [];
    const resolvers: Array<(r: IteratorResult<AdapterDelta>) => void> = [];
    let done = false;
    let resultResolve!: (v: TRaw) => void;
    let resultReject!: (e: unknown) => void;
    const resultPromise = new Promise<TRaw>((res, rej) => {
      resultResolve = res;
      resultReject = rej;
    });

    const controller = new AbortController();
    if (input.signal) {
      if (input.signal.aborted) controller.abort(input.signal.reason);
      else
        input.signal.addEventListener("abort", () => controller.abort(input.signal!.reason), {
          once: true,
        });
    }

    const executeInput: ExecuteInput<LanguageModelInput> = {
      ...input,
      signal: controller.signal,
    };
    const streamOp: Operation<ExecuteInput<LanguageModelInput>, unknown> = {
      opId: `executor:execute:${executionId}:${ulid()}`,
      surface: "executor",
      name: "executor:command:execute",
      scope: executeInput.scope ?? { executionId },
      input: executeInput,
    };

    const sink = (delta: AdapterDelta): void => {
      if (done) return;
      const r = resolvers.shift();
      if (r) r({ value: delta, done: false });
      else queue.push(delta);
    };

    const completeIteration = (): void => {
      done = true;
      while (resolvers.length > 0) {
        resolvers.shift()!({ value: undefined as unknown as AdapterDelta, done: true });
      }
    };

    // Drive on a detached promise — both the iterator and `.result`
    // are backed by it.
    void runHarnessProtocol(
      this.runOperation(streamOp, (i) =>
        this.executeBody(i, executionId, streamOp as Operation<unknown, unknown>, sink),
      ),
    )
      .then((raw) => {
        resultResolve(raw as TRaw);
        completeIteration();
      })
      .catch((err) => {
        resultReject(err);
        done = true;
        while (resolvers.length > 0) {
          resolvers.shift()!({ value: undefined as unknown as AdapterDelta, done: true });
        }
      });
    void executeInput; // (the merged-signal copy is what the inner runOperation uses)

    return {
      result: resultPromise,
      abort: (reason) => {
        controller.abort(reason ?? "aborted");
      },
      [Symbol.asyncIterator]() {
        return {
          next: (): Promise<IteratorResult<AdapterDelta>> => {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift()!, done: false });
            }
            if (done) {
              return Promise.resolve({ value: undefined as unknown as AdapterDelta, done: true });
            }
            return new Promise((resolve) => resolvers.push(resolve));
          },
          return: (): Promise<IteratorResult<AdapterDelta>> => {
            completeIteration();
            return Promise.resolve({ value: undefined as unknown as AdapterDelta, done: true });
          },
        };
      },
    };
  }

  normalize(input: NormalizeInput<unknown>): Promise<LanguageModelExecutionResult> {
    const op: Operation<NormalizeInput<unknown>, LanguageModelExecutionResult> = {
      opId: `executor:normalize:${ulid()}`,
      surface: "executor",
      name: "executor:command:normalize",
      scope: input.scope ?? {},
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.try({
          try: () => this.normalizeRaw(i.targetOutput as TRaw),
          catch: (cause): NormalizeError => ({
            _tag: "NormalizationFailed",
            cause,
          }),
        }),
      ),
    );
  }

  run(input: RunInput): Promise<ExecutorTerminal<LanguageModelExecutionResult>> {
    const executionId = input.scope?.executionId ?? `exec:${ulid()}`;
    const tickId = input.scope?.tickId;
    const opId =
      tickId !== undefined
        ? `executor:run:${executionId}:${tickId}`
        : `executor:run:${executionId}:${ulid()}`;
    const op: Operation<RunInput, ExecutorTerminal<LanguageModelExecutionResult>> = {
      opId,
      surface: "executor",
      name: "executor:command:run",
      scope: { ...(input.scope ?? {}), executionId },
      input,
    };
    return runHarnessProtocol(this.runOperation(op, (i) => this.runBody(i, executionId, op)));
  }

  abort(input: AbortExecutorInput): Promise<void> {
    return runHarnessProtocol(
      Effect.sync(() => {
        const entry = this.inFlight.get(input.executionId);
        if (entry) {
          entry.abortReason = input.reason ?? "aborted";
          entry.abort?.abort(input.reason ?? "aborted");
        }
        this.aborted.add(input.executionId);
      }),
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────

  private executeBody(
    input: ExecuteInput<LanguageModelInput>,
    executionId: string,
    op: Operation<unknown, unknown>,
    sink: ((delta: AdapterDelta) => void) | null,
  ): Effect.Effect<TRaw, ExecuteError, never> {
    return Effect.gen(this, function* () {
      if (this.aborted.has(executionId)) {
        return yield* Effect.fail<ExecuteError>({
          _tag: "ProviderAborted",
          reason: "aborted prior to execute",
        });
      }

      const controller = new AbortController();
      const entry: InFlightEntry = { executionId, abort: controller };
      this.inFlight.set(executionId, entry);

      try {
        const params = this.buildParams(input.targetInput, input.target);
        const signal = mergeSignals(input.signal, controller.signal);
        // Force streaming when called from executeStream (sink non-null);
        // execute() opts in via streamByDefault. Target capabilities can
        // veto streaming for execute() but not for executeStream() — the
        // caller explicitly asked for the iterator.
        const wantStream =
          sink !== null ||
          (this.streamByDefault &&
            this.supportsRunStreaming &&
            (input.target.capabilities?.supportsStreaming ?? true));

        if (!wantStream) {
          return yield* Effect.tryPromise<TRaw, ExecuteError>({
            try: () => this.callProvider(params, signal),
            catch: (cause): ExecuteError => this.mapProviderError(cause),
          });
        }

        // Streaming path — base owns the emit construction (bus +
        // iterator), subclass owns the chunk loop.
        const harness = this;
        const emit = (delta: AdapterDelta): void => {
          // Bus side — fire-and-forget; ignore subscriber-count drops.
          void Effect.runPromise(
            harness.emitDeltaLazy(op, () => delta).pipe(Effect.catchAll(() => Effect.void)),
          );
          // Iterator side — only when executeStream is the entry point.
          if (sink) sink(delta);
        };

        return yield* Effect.tryPromise<TRaw, ExecuteError>({
          try: () =>
            this.drainStream(params, {
              signal,
              emit,
              executionId,
            }),
          catch: (cause): ExecuteError => this.mapProviderError(cause),
        });
      } finally {
        this.inFlight.delete(executionId);
      }
    });
  }

  private runBody(
    input: RunInput,
    executionId: string,
    op: Operation<RunInput, ExecutorTerminal<LanguageModelExecutionResult>>,
  ): Effect.Effect<ExecutorTerminal<LanguageModelExecutionResult>, ExecutorError, never> {
    return Effect.gen(this, function* () {
      // Pre-execution abort short-circuit. Mid-stream aborts surface as
      // `ProviderAborted` from `executeBody` and are caught below.
      if (this.aborted.has(executionId)) {
        const terminal: ExecutorTerminal<LanguageModelExecutionResult> = {
          outcome: "canceled",
          reason: this.inFlight.get(executionId)?.abortReason ?? "aborted",
        };
        return terminal;
      }

      // 1. project (pure)
      const projected = this.projectImpl({
        compiled: input.compiled,
        target: input.target,
      });

      // 2. execute (provider call; may stream + emit deltas)
      const executeInput: ExecuteInput<LanguageModelInput> = {
        targetInput: projected,
        target: input.target,
        scope: { ...(input.scope ?? {}), executionId },
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      };
      const raw = yield* this.executeBody(
        executeInput,
        executionId,
        op as Operation<unknown, unknown>,
        null,
      ).pipe(
        Effect.catchTag("ProviderAborted", (e) =>
          Effect.succeed<ExecutorTerminal<LanguageModelExecutionResult>>({
            outcome: "canceled",
            reason: e.reason ?? "aborted",
          }),
        ),
      );

      // ProviderAborted recovery returned a terminal directly — pass through.
      if (isTerminal(raw)) {
        return raw;
      }

      // 3. post-process (tag-router for OpenAI/Anthropic/Google; identity by default)
      const rawForNormalize = this.postProcessForNormalize(raw as TRaw);

      // 4. normalize (deterministic)
      const result = yield* Effect.try({
        try: () => this.normalizeRaw(rawForNormalize),
        catch: (cause): ExecutorError => ({
          _tag: "NormalizationFailed",
          cause,
        }),
      });

      const terminal: ExecutorTerminal<LanguageModelExecutionResult> = {
        outcome: "succeeded",
        result,
      };
      return terminal;
    });
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isTerminal(v: unknown): v is ExecutorTerminal<LanguageModelExecutionResult> {
  return (
    typeof v === "object" &&
    v !== null &&
    "outcome" in v &&
    (v as { outcome?: unknown }).outcome === "canceled"
  );
}

/**
 * Merge an optional caller signal with the internal controller signal
 * into one composite signal. When either fires, the composite fires.
 */
export function mergeSignals(caller: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
  if (caller === undefined) return internal;
  if (caller.aborted) return caller;
  if (internal.aborted) return internal;
  const ctrl = new AbortController();
  const onCaller = (): void => ctrl.abort(caller.reason);
  const onInternal = (): void => ctrl.abort(internal.reason);
  caller.addEventListener("abort", onCaller, { once: true });
  internal.addEventListener("abort", onInternal, { once: true });
  return ctrl.signal;
}
