/**
 * CommandRunner (ADR 51 + A2.4) — the command subsystem as a standalone,
 * per-harness deployable instance.
 *
 * A harness verb (ADR 51 §2) has ONE declaration site (`command` /
 * `commandStream`), whose canonical `name` is simultaneously the inbox message
 * type, the op-name root, the authz scope label, and (via `:` → `/`) the wire
 * method name. This module owns everything downstream of that string: the
 * registry {@link Map}, the ONE shared Operation-manufacture
 * ({@link CommandRunnerImpl.manufactureCommandRun}) both faces route through,
 * the wire-safe {@link CommandRunner.commands} listing, {@link CommandRunner.get}
 * for inbox dispatch, and the per-command chunk-interceptor lists (ADR 80
 * Phase 2 — command-scoped state, so it lives WITH the commands).
 *
 * **`runOperation` is an INJECTED capability, not absorbed.** The runner never
 * touches journal / bus / interceptor-inheritance / identity — those stay fused
 * to the operation-execution layer on {@link BaseHarness} (the named-future
 * `createOperationRunner`, Tier 2). The runner receives a bound
 * {@link OperationRunner} and composes the command layer on top. Each
 * `createCommandRunner` call yields an isolated instance (its own registry +
 * chunk maps) — the module holds NO shared registries.
 *
 * @see docs/proposals/v2/blueprint/51-invocation-and-authorization.md
 * @see docs/proposals/v2/STATUS.md — ROADMAP A2.4
 */

import { Effect } from "effect";
import type { Fiber } from "effect";
import { isThenable, omitUndefined } from "@agentick/utils-next";
import type {
  AsyncStream,
  ChunkInterceptor,
  CommandDescriptor,
  CommandExposure,
  CommandInfo,
  EventScope,
  Operation,
  OperationOrigin,
  StandardSchemaV1,
  SubstrateError,
  Unsubscribe,
} from "@agentick/spec-next";
import { CommandDeclarationError, deriveChunkHookName } from "@agentick/spec-next";
import { getContext, type RuntimeContext } from "./runtime-context.js";
import { ulid } from "./ulid.js";
import { runHarnessProtocol, runHarnessStream } from "./harness-protocol.js";

// ============================================================================
// Public shapes
// ============================================================================

/**
 * The three consumption faces {@link CommandRunner.commandStream} returns for
 * one declared streaming verb — all driving the SAME cascade-wrapped operation
 * (guard → onBefore(input) → body → onAfter(R)), differing ONLY in how the
 * caller consumes the one run:
 *
 *   - **`fx`** — the Effect-native **sink-fold twin** (`fx(input, sink) =>
 *     Effect<R>`). EXACTLY the internal cascade-wrapped body, un-run and without
 *     the Queue/fork bridge — so an in-fiber caller (the loop's per-tick model
 *     call) composes it with `yield*` and the model call rides the SAME
 *     interceptor cascade + boundary hooks + guard. This is why the loop's
 *     streaming model call gets `onBefore/AfterModelGenerateStream` + guard.
 *   - **`stream`** — the JS async-iterable edge: `for await` drains the chunks,
 *     `.result` resolves to `R`. Projects `fx` onto {@link AsyncStream} via
 *     `runHarnessStream`, threading the streaming-edge policy (`def.stream`).
 *   - **`run`** — the drain-to-`R` Promise (no-op sink), the shape an
 *     inbox/remote caller of the declared verb gets. The boundary hooks +
 *     terminal fire exactly once, identically to the other two faces.
 */
export interface StreamCommand<I, Chunk, R, E = never> {
  readonly stream: (
    input: I,
    opts?: { readonly origin?: OperationOrigin },
  ) => AsyncStream<Chunk, R>;
  readonly fx: (
    input: I,
    sink: (chunk: Chunk) => Effect.Effect<void>,
    opts?: { readonly origin?: OperationOrigin },
  ) => Effect.Effect<R, E | SubstrateError, never>;
  readonly run: (input: I, opts?: { readonly origin?: OperationOrigin }) => Promise<R>;
}

/**
 * A declared command in a harness's registry (ADR 51): the wire-safe
 * descriptor plus the bound runner that manufactures the Operation and
 * routes it through the injected {@link OperationRunner}.
 */
export interface RegisteredCommand {
  readonly descriptor: CommandDescriptor;
  readonly run: (
    input: unknown,
    opts: {
      readonly origin: OperationOrigin;
      readonly parentOpId?: string;
      readonly correlationId?: string;
    },
  ) => Effect.Effect<unknown, unknown, never>;
}

/** Origin-stamping option every public command face accepts. */
export interface CommandInvokeOpts {
  readonly origin?: OperationOrigin;
}

/** The declaration shape for a non-streaming command ({@link CommandRunner.command}). */
export interface CommandDef<I, R, E> {
  /** Canonical verb — must be prefixed `"${surface}:"`. */
  readonly name: string;
  /** Standard Schema for the payload; validated at inbox dispatch. */
  readonly input?: StandardSchemaV1<I>;
  /** Reachability (ADR 51 §2.3). Default `"addressable"`. */
  readonly exposure?: CommandExposure;
  readonly description?: string;
  /**
   * Work-path scope dims for the Operation (surface-specific). Receives the
   * command input so input-derived dims are expressible; static-scope
   * declarations ignore the arg. The gate's `origin` is merged in; `principal`
   * is stamped by the operation-execution layer regardless.
   */
  readonly scope?: (input: I) => EventScope;
  /**
   * Deterministic opId derivation (ADR 51 idempotency). By default a fresh
   * `${name}:${ulid()}` opId per invocation; supply a pure function of the input
   * for a re-invocation that must replay the cached terminal.
   */
  readonly opId?: (input: I) => string;
  readonly handler: (input: I) => Effect.Effect<R, E, never>;
}

/** The declaration shape for a streaming command ({@link CommandRunner.commandStream}). */
export interface StreamCommandDef<I, Chunk, R, E> {
  /** Canonical verb — must be prefixed `"${surface}:"`. */
  readonly name: string;
  /** Standard Schema for the payload; validated at inbox dispatch. */
  readonly input?: StandardSchemaV1<I>;
  /** Reachability (ADR 51 §2.3). Default `"addressable"`. */
  readonly exposure?: CommandExposure;
  readonly description?: string;
  /** Work-path scope dims (surface-specific — receives the input). */
  readonly scope?: (input: I) => EventScope;
  /** Deterministic opId derivation (ADR 51 idempotency). */
  readonly opId?: (input: I) => string;
  /**
   * Emits chunks via `sink`, returns the final result. Runs INSIDE the
   * operation cascade — guard/onBefore already applied to `input`, onAfter
   * applied to the returned `R`.
   */
  readonly body: (
    input: I,
    sink: (chunk: Chunk) => Effect.Effect<void>,
  ) => Effect.Effect<R, E, never>;
  /**
   * Declaration-time per-chunk interceptors (ADR 80 Phase 2) — the programmatic
   * twin of the minted `hooks.on<Verb>Chunk(...)` registrar. SINK-WRAP the
   * body's sink in list order; composed OUTERMOST of any dynamically-registered
   * interceptors (declared first = closest to the body).
   */
  readonly chunk?: readonly ChunkInterceptor<Chunk, RuntimeContext>[];
  /**
   * Streaming-edge policy for the `.stream` (AsyncStream) face ONLY — the `.fx`
   * sink-fold twin and the `.run` drain ignore it. Threads the
   * {@link runHarnessStream} knobs a concrete streaming command needs; each hook
   * is ALSO handed the invocation `input`, so per-call state is reachable.
   */
  readonly stream?: {
    readonly queueCapacity?: number;
    readonly isCancellation?: (cause: unknown) => boolean;
    readonly onStart?: (fiber: Fiber.RuntimeFiber<R, unknown>, input: I) => void;
    readonly onAbort?: (reason: string, input: I) => void;
  };
}

/**
 * The heavy-path operation executor the runner composes the command layer on
 * top of — {@link BaseHarness.runOperation}, bound to its harness instance and
 * injected at construction. The runner treats it as an opaque capability: it
 * manufactures the {@link Operation} and hands off; journaling, idempotency,
 * the phase contract, the interceptor cascade, and identity stamping all live
 * behind this function.
 */
export type OperationRunner = <I, R, E>(
  op: Operation<I, R, E>,
  body: (input: I) => Effect.Effect<R, E, never>,
) => Effect.Effect<R, E | SubstrateError, never>;

/** Construction dependencies for {@link createCommandRunner}. */
export interface CommandRunnerDeps {
  /** The declaring harness's event surface — the required verb prefix + op-name root. */
  readonly surface: string;
  /** The bound operation executor (see {@link OperationRunner}). */
  readonly runOperation: OperationRunner;
}

/**
 * The command subsystem as an instance. One per harness; owns the registry, the
 * command manufacture, the chunk-interceptor lists, and the wire-safe listing.
 */
export interface CommandRunner {
  /** Declare a command (heavy path). Returns the public Promise method. */
  command<I, R, E>(def: CommandDef<I, R, E>): (input: I, opts?: CommandInvokeOpts) => Promise<R>;
  /** Declare a streaming command. Returns the three-face {@link StreamCommand}. */
  commandStream<I, Chunk, R, E>(
    def: StreamCommandDef<I, Chunk, R, E>,
  ): StreamCommand<I, Chunk, R, E>;
  /**
   * Effect-native invocation of a declared command — the intra-harness
   * composition path (stays in-fiber so nested `parentOpId` auto-threads).
   */
  commandEffect<I, R, E>(
    name: string,
    input: I,
    opts?: CommandInvokeOpts,
  ): Effect.Effect<R, E | SubstrateError, never>;
  /** Enumerate declared commands as wire-safe summaries (ADR 51 §2.4). */
  commands(): readonly CommandInfo[];
  /** Look up a registered command by canonical name (for inbox dispatch). */
  get(name: string): RegisteredCommand | undefined;
  /**
   * Register a per-chunk interceptor (ADR 80 Phase 2) under its minted hook name
   * (`on<Verb>Chunk`). Returns an {@link Unsubscribe} removing exactly that
   * interceptor by identity.
   */
  registerChunkInterceptor(
    key: string,
    interceptor: ChunkInterceptor<unknown, RuntimeContext>,
  ): Unsubscribe;
}

/**
 * Construct a {@link CommandRunner} bound to one harness's surface + operation
 * executor. Stateless at the module level — every instance owns its own registry
 * and chunk-interceptor maps (multi-instance isolation).
 */
export function createCommandRunner(deps: CommandRunnerDeps): CommandRunner {
  return new CommandRunnerImpl(deps);
}

// ============================================================================
// Per-chunk interception pipeline (ADR 80 Phase 2)
// ============================================================================
//
// A chunk interceptor SINK-WRAPS a streaming command's sink: it runs BETWEEN
// the body's emit and the downstream sink (the bounded queue for `.stream`, the
// caller's sink for `.fx`, the no-op sink for `.run`). Multiple interceptors
// compose into a pipeline `body → i0 → i1 → … → downstream`. Because the wrap
// is on the SINK, all three consumption faces see transformed chunks.

/**
 * The normalized (kind-tagged) internal form of a {@link ChunkInterceptor}, with
 * `Ctx` bound to {@link RuntimeContext}. The public union is shape-discriminated
 * (`observe` vs `onChunk`); {@link normalizeChunkInterceptor} tags it once at
 * registration so the hot per-chunk path is a cheap discriminant check.
 */
type ResolvedChunkInterceptor<Chunk> =
  | {
      readonly kind: "observe";
      readonly observe: (chunk: Chunk, ctx: RuntimeContext) => void | Promise<void>;
    }
  | {
      readonly kind: "transform";
      readonly onChunk: (
        chunk: Chunk,
        emit: (chunk: Chunk) => void,
        ctx: RuntimeContext,
      ) => void | Promise<void>;
      readonly onFlush?: (
        emit: (chunk: Chunk) => void,
        ctx: RuntimeContext,
      ) => void | Promise<void>;
    };

/** Tag a {@link ChunkInterceptor} by shape into a {@link ResolvedChunkInterceptor}. */
function normalizeChunkInterceptor<Chunk>(
  interceptor: ChunkInterceptor<Chunk, RuntimeContext>,
): ResolvedChunkInterceptor<Chunk> {
  if ("observe" in interceptor) {
    return { kind: "observe", observe: interceptor.observe };
  }
  return {
    kind: "transform",
    onChunk: interceptor.onChunk,
    ...(interceptor.onFlush !== undefined ? { onFlush: interceptor.onFlush } : {}),
  };
}

/** Lift a hook callback's `void | Promise<void>` result onto the Effect channel. */
function chunkStep(result: void | Promise<void>): Effect.Effect<void> {
  return isThenable(result) ? Effect.promise(() => result as Promise<void>) : Effect.void;
}

/**
 * Run ONE interceptor stage for a chunk, feeding its output to `downstream`. An
 * `observe` stage taps (awaited, in order) then forwards the chunk UNCHANGED; a
 * `transform` stage buffers its `emit`ted chunks (zero → drop/coalesce, one →
 * map, many → fan-out) then forwards each downstream.
 */
function runChunkStage<Chunk>(
  stage: ResolvedChunkInterceptor<Chunk>,
  chunk: Chunk,
  downstream: (chunk: Chunk) => Effect.Effect<void>,
  ctx: RuntimeContext,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (stage.kind === "observe") {
      yield* chunkStep(stage.observe(chunk, ctx));
      yield* downstream(chunk);
      return;
    }
    const buffer: Chunk[] = [];
    yield* chunkStep(stage.onChunk(chunk, (c) => buffer.push(c), ctx));
    for (const c of buffer) yield* downstream(c);
  });
}

/**
 * Compose a chunk-interceptor list into a wrapped `sink` + a terminal `flush`
 * (ADR 80 Phase 2). The body emits into `sink` (stage 0), which cascades through
 * each stage to `realSink`. `flush` — run ONCE at the terminal boundary, after
 * the body's last emit and BEFORE `onAfter` — walks the stages in order,
 * releasing each transform's buffered tail into the NEXT stage's entry sink
 * (so a downstream combiner still coalesces the upstream's flushed remainder).
 * This is the flush-on-terminal contract; it is reached only on clean
 * completion (an interrupted body never returns, so `flush` never runs → no
 * bogus tail on abort).
 */
function buildChunkPipeline<Chunk>(
  interceptors: readonly ResolvedChunkInterceptor<Chunk>[],
  realSink: (chunk: Chunk) => Effect.Effect<void>,
  ctx: RuntimeContext,
): {
  readonly sink: (chunk: Chunk) => Effect.Effect<void>;
  readonly flush: () => Effect.Effect<void>;
} {
  const n = interceptors.length;
  // sinks[i] is the ENTRY sink for stage i; sinks[n] is the real downstream sink.
  const sinks: ((chunk: Chunk) => Effect.Effect<void>)[] = new Array(n + 1);
  sinks[n] = realSink;
  for (let i = n - 1; i >= 0; i--) {
    const stage = interceptors[i]!;
    const downstream = sinks[i + 1]!;
    sinks[i] = (chunk) => runChunkStage(stage, chunk, downstream, ctx);
  }
  const flush = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (let i = 0; i < n; i++) {
        const stage = interceptors[i]!;
        if (stage.kind !== "transform" || stage.onFlush === undefined) continue;
        const buffer: Chunk[] = [];
        yield* chunkStep(stage.onFlush((c) => buffer.push(c), ctx));
        const downstream = sinks[i + 1]!;
        for (const c of buffer) yield* downstream(c);
      }
    });
  return { sink: sinks[0] ?? realSink, flush };
}

// ============================================================================
// Implementation
// ============================================================================

type RunOpts = {
  readonly origin: OperationOrigin;
  readonly parentOpId?: string;
  readonly correlationId?: string;
};

class CommandRunnerImpl implements CommandRunner {
  private readonly surface: string;
  private readonly runOperation: OperationRunner;

  /**
   * The command registry (ADR 51) — canonical name → {@link RegisteredCommand}.
   * The single source of truth every invocation path (public method, `.fx`
   * twin, inbox dispatch, `commands()` listing) reads.
   */
  private readonly registry = new Map<string, RegisteredCommand>();

  /**
   * Per-command chunk interceptors (ADR 80 Phase 2), keyed by the minted hook
   * name (`on<Verb>Chunk`, via {@link deriveChunkHookName}). SINK-WRAPPING, not
   * op-scoped middleware — so they live HERE (command-scoped state), NOT on the
   * harness's interceptor chain. Read live per streaming run by
   * {@link commandStream}: when a verb's list is empty (the common case) the
   * sink is not wrapped at all (zero overhead).
   *
   * TODO(phase-2+): these are harness-LOCAL (they do not inherit down the
   * construction tree the way `.use`/`.guard`/`.hook` middleware does, and a
   * declarative session-config `{ hooks: { onXChunk } }` is NOT folded through
   * `hooksToMiddlewares`). Session-scoped chunk interceptors (register on the
   * session, reach the shared executor) are a follow-up — see the task note.
   */
  private readonly chunkInterceptors = new Map<string, ResolvedChunkInterceptor<unknown>[]>();

  constructor(deps: CommandRunnerDeps) {
    this.surface = deps.surface;
    this.runOperation = deps.runOperation;
  }

  command<I, R, E>(def: CommandDef<I, R, E>): (input: I, opts?: CommandInvokeOpts) => Promise<R> {
    const opName = this.declare(def.name);
    const run = this.manufactureCommandRun<I, R, E>(def.name, opName, def, def.handler);
    this.register(def, run as RegisteredCommand["run"]);
    return (input, opts) => runHarnessProtocol(run(input, { origin: opts?.origin ?? "host" }));
  }

  commandStream<I, Chunk, R, E>(
    def: StreamCommandDef<I, Chunk, R, E>,
  ): StreamCommand<I, Chunk, R, E> {
    const opName = this.declare(def.name);

    // Per-chunk interception (ADR 80 Phase 2). Declaration-time interceptors are
    // normalized once here; dynamic ones (`hooks.on<Verb>Chunk(...)`) are read
    // LIVE per run from `this.chunkInterceptors` under the minted hook name. The
    // effective list per run is `[...declared, ...dynamic]` (declared closest to
    // the body). When BOTH are empty the sink is not wrapped at all.
    const chunkHookName = deriveChunkHookName(opName);
    const declaredChunk = (def.chunk ?? []).map(normalizeChunkInterceptor);
    const chunkInterceptorsFor = this.chunkInterceptors;

    // Wrap the body's sink with the effective chunk pipeline, flushing any
    // buffered tail BEFORE returning `R` (hence before the `onAfter` boundary
    // hook). Zero-overhead when no interceptor is registered. On abort the body
    // is interrupted before `flush` — no bogus tail.
    const runBodyWithChunks = (
      i: I,
      sink: (chunk: Chunk) => Effect.Effect<void>,
    ): Effect.Effect<R, E, never> => {
      const dynamic = chunkInterceptorsFor.get(chunkHookName) as
        | ResolvedChunkInterceptor<Chunk>[]
        | undefined;
      const hasDynamic = dynamic !== undefined && dynamic.length > 0;
      if (declaredChunk.length === 0 && !hasDynamic) {
        return def.body(i, sink); // zero-overhead — no sink wrap
      }
      const list = hasDynamic ? [...declaredChunk, ...dynamic!] : declaredChunk;
      return Effect.gen(function* () {
        const ctx = yield* getContext;
        const { sink: wrapped, flush } = buildChunkPipeline<Chunk>(list, sink, ctx);
        const result = yield* def.body(i, wrapped);
        yield* flush();
        return result;
      });
    };

    // The cascade-wrapped, sink-folding body — the ONE Operation manufacture
    // (shared with `command` via `manufactureCommandRun`), differing ONLY in the
    // sink-threading body. `streamFx` builds a fresh run per sink so `fx`,
    // `stream`, and `run` each drive the same single cascade-wrapped operation.
    const streamFx = (
      input: I,
      sink: (chunk: Chunk) => Effect.Effect<void>,
      opts: RunOpts,
    ): Effect.Effect<R, E | SubstrateError, never> =>
      this.manufactureCommandRun<I, R, E>(def.name, opName, def, (i) => runBodyWithChunks(i, sink))(
        input,
        opts,
      );

    // The inbox-addressable registry `run`: drive the SAME operation to
    // completion with a no-op sink and return the drained `R`.
    const run = (input: I, opts: RunOpts): Effect.Effect<R, E | SubstrateError, never> =>
      streamFx(input, () => Effect.void, opts);

    this.register(def, run as RegisteredCommand["run"]);

    return {
      fx: (input, sink, opts) => streamFx(input, sink, { origin: opts?.origin ?? "host" }),
      stream: (input, opts) =>
        runHarnessStream<Chunk, R>(
          (sink) => streamFx(input, sink, { origin: opts?.origin ?? "host" }),
          {
            ...(def.stream?.queueCapacity !== undefined
              ? { queueCapacity: def.stream.queueCapacity }
              : {}),
            ...(def.stream?.isCancellation !== undefined
              ? { isCancellation: def.stream.isCancellation }
              : {}),
            ...(def.stream?.onStart !== undefined
              ? {
                  onStart: (fiber: Fiber.RuntimeFiber<R, unknown>) =>
                    def.stream!.onStart!(fiber, input),
                }
              : {}),
            ...(def.stream?.onAbort !== undefined
              ? { onAbort: (reason: string) => def.stream!.onAbort!(reason, input) }
              : {}),
          },
        ),
      run: (input, opts) => runHarnessProtocol(run(input, { origin: opts?.origin ?? "host" })),
    };
  }

  commandEffect<I, R, E>(
    name: string,
    input: I,
    opts?: CommandInvokeOpts,
  ): Effect.Effect<R, E | SubstrateError, never> {
    const reg = this.registry.get(name);
    if (reg === undefined) {
      throw new CommandDeclarationError({ command: name, reason: "not declared on this harness" });
    }
    return reg.run(input, { origin: opts?.origin ?? "host" }) as Effect.Effect<
      R,
      E | SubstrateError,
      never
    >;
  }

  commands(): readonly CommandInfo[] {
    return Array.from(this.registry.values(), ({ descriptor: d }) => ({
      name: d.name,
      exposure: d.exposure,
      hasInput: d.input !== undefined,
      ...omitUndefined({ description: d.description }),
    }));
  }

  get(name: string): RegisteredCommand | undefined {
    return this.registry.get(name);
  }

  registerChunkInterceptor(
    key: string,
    interceptor: ChunkInterceptor<unknown, RuntimeContext>,
  ): Unsubscribe {
    const resolved = normalizeChunkInterceptor(interceptor);
    let list = this.chunkInterceptors.get(key);
    if (list === undefined) {
      list = [];
      this.chunkInterceptors.set(key, list);
    }
    list.push(resolved);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const current = this.chunkInterceptors.get(key);
      if (current === undefined) return;
      const idx = current.indexOf(resolved);
      if (idx >= 0) current.splice(idx, 1);
    };
  }

  // ──────── shared manufacture (the dedup) ────────

  /**
   * Validate a verb declaration and derive its op name. The prefix rule (ADR 51
   * §1.2) and the duplicate rule are enforced HERE, once, shared by `command`
   * and `commandStream`. Returns `"${surface}:command:${verb}"`.
   */
  private declare(name: string): string {
    if (!name.startsWith(`${this.surface}:`)) {
      throw new CommandDeclarationError({
        command: name,
        reason: `verb prefix must match the declaring surface "${this.surface}"`,
      });
    }
    if (this.registry.has(name)) {
      throw new CommandDeclarationError({ command: name, reason: "duplicate declaration" });
    }
    return `${this.surface}:command:${name.slice(this.surface.length + 1)}`;
  }

  /**
   * The ONE Operation-manufacture (A2.4 dedup). Given a `body`, returns the
   * `run(input, opts) => Effect` that builds the canonical {@link Operation}
   * (`opId` per the idempotency rule, `surface`, `name`, causality, scope +
   * origin, input) and routes it through the injected {@link OperationRunner}.
   * `command` passes `def.handler`; `commandStream` passes its sink-threading
   * body — the ONLY delta between the two faces.
   */
  private manufactureCommandRun<I, R, E>(
    name: string,
    opName: string,
    def: { readonly scope?: (input: I) => EventScope; readonly opId?: (input: I) => string },
    body: (input: I) => Effect.Effect<R, E, never>,
  ): (input: I, opts: RunOpts) => Effect.Effect<R, E | SubstrateError, never> {
    return (input, opts) =>
      this.runOperation<I, R, E>(
        {
          opId: def.opId?.(input) ?? `${name}:${ulid()}`,
          surface: this.surface,
          name: opName,
          ...omitUndefined({ parentOpId: opts.parentOpId, correlationId: opts.correlationId }),
          scope: omitUndefined({ ...(def.scope?.(input) ?? {}), origin: opts.origin }),
          input,
        },
        body,
      );
  }

  /**
   * Register the wire-safe descriptor + bound `run` under the canonical name.
   * Shared by `command` and `commandStream` (identical descriptor build).
   */
  private register<I>(
    def: {
      readonly name: string;
      readonly exposure?: CommandExposure;
      readonly description?: string;
      readonly input?: StandardSchemaV1<I>;
    },
    run: RegisteredCommand["run"],
  ): void {
    this.registry.set(def.name, {
      descriptor: {
        name: def.name,
        exposure: def.exposure ?? "addressable",
        ...omitUndefined({ input: def.input as StandardSchemaV1 | undefined }),
        ...omitUndefined({ description: def.description }),
      },
      run,
    });
  }
}
