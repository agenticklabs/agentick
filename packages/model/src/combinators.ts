/**
 * Adapter combinators (#183) — resilience and routing as pure function
 * composition. Adapters are plain Promise-shaped values (ADR 52), so
 * retry, failover, and observability taps are wrappers, not subsystems:
 *
 * ```ts
 * model: withFallback(openai("gpt-5"), anthropic("claude-sonnet-5"))
 * model: withRetry(openai("gpt-4o"), { attempts: 3 })
 * model: tapModel(adapter, { onCall, onResult })
 * ```
 *
 * Semantics (ratified on #183):
 * - `withRetry` retries the non-streaming call and the stream START
 *   (open + first chunk — generator-shaped adapters surface start
 *   failures only on first pull) on transient errors; once a chunk has
 *   been observed, errors propagate — no partial-stream replay.
 * - `withFallback` engages the next adapter when the current one's
 *   call/open fails; NEVER on abort. Delegation starts at each adapter's OWN
 *   `prepareRequest` — the native request is provider-specific, so it is
 *   rebuilt per adapter, never handed over to `send` / `openStream` of a
 *   different provider.
 * - Neither combinator retries/fails-over mid-stream.
 *
 * // TODO(trail-cost-routing): a `routeModel(picker, ...adapters)`
 * // combinator (pick by capability/cost/health) composes from the same
 * // delegation machinery `withFallback` builds here.
 */

import type {
  AdapterDelta,
  ExecuteErrorChannel,
  ExecuteInput,
  LanguageModelExecutionResult,
  LanguageModelInput,
  ExecutionTarget,
  ProjectInput,
} from "@agentick/spec";

import {
  defaultFinalizeStream,
  type LanguageModelAdapter,
  type StreamAccumulatorView,
} from "./language-model-adapter.js";
import type { DeltaTransform } from "./delta-transform.js";

// ============================================================================
// withRetry
// ============================================================================

export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  readonly attempts?: number;
  /** Base backoff in ms (exponential, full jitter). Default 250. */
  readonly backoffMs?: number;
  /** Retry predicate. Default: {@link isTransientProviderError}. */
  readonly retryOn?: (cause: unknown, attempt: number) => boolean;
}

/**
 * Transient-by-default: HTTP 429 / 5xx (duck-typed `status` /
 * `statusCode` across provider SDKs) and network-level failures
 * (`ECONNRESET`, `ETIMEDOUT`, fetch's `TypeError`-shaped failures).
 */
export function isTransientProviderError(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const c = cause as { status?: unknown; statusCode?: unknown; code?: unknown; name?: unknown };
  const status = typeof c.status === "number" ? c.status : c.statusCode;
  if (typeof status === "number") return status === 429 || status >= 500;
  if (typeof c.code === "string") {
    return ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "EAI_AGAIN"].includes(c.code);
  }
  return c.name === "FetchError";
}

function isAborted(
  signal: AbortSignal | undefined,
  adapter: LanguageModelAdapter<never, never>,
  cause: unknown,
): boolean {
  if (signal?.aborted) return true;
  return adapter.isAbortError?.(cause) ?? false;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Open a stream AND pull its first chunk. "The stream has started" is
 * defined as "produced its first chunk" — generator-shaped adapters
 * defer all errors to iteration, so an open-only probe would never see
 * a failure to start. The pulled chunk is re-yielded first.
 */
async function openThroughFirstChunk<TRaw, TChunk>(
  adapter: LanguageModelAdapter<TRaw, TChunk>,
  request: unknown,
  signal: AbortSignal | undefined,
): Promise<AsyncIterable<TChunk>> {
  if (!adapter.openStream) {
    throw new Error(`adapter '${adapter.provider}' does not support streaming (no openStream)`);
  }
  const iter = await adapter.openStream(request, signal);
  const it = iter[Symbol.asyncIterator]();
  const first = await it.next(); // failures to START surface here
  return (async function* reassemble(): AsyncIterable<TChunk> {
    if (!first.done) yield first.value;
    while (true) {
      const n = await it.next();
      if (n.done) return;
      yield n.value;
    }
  })();
}

/**
 * Retry transient provider failures with jittered exponential backoff.
 * Streaming retries the START only (through the first chunk) — a
 * stream that has produced output is never replayed. Abort is never
 * retried.
 */
export function withRetry<TRaw, TChunk>(
  adapter: LanguageModelAdapter<TRaw, TChunk>,
  options: RetryOptions = {},
): LanguageModelAdapter<TRaw, TChunk> {
  const attempts = options.attempts ?? 3;
  const backoffMs = options.backoffMs ?? 250;
  const retryOn = options.retryOn ?? isTransientProviderError;

  async function attempt<T>(fn: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    let lastCause: unknown;
    for (let i = 1; i <= attempts; i++) {
      try {
        return await fn();
      } catch (cause) {
        lastCause = cause;
        const abortish = isAborted(signal, adapter as LanguageModelAdapter<never, never>, cause);
        if (abortish || i === attempts || !retryOn(cause, i)) throw cause;
        await delay(backoffMs * 2 ** (i - 1) * Math.random());
      }
    }
    throw lastCause;
  }

  return {
    ...adapter,
    send: (request, signal) => attempt(() => adapter.send(request, signal), signal),
    ...(adapter.openStream !== undefined
      ? {
          openStream: (request: TRequestOf<typeof adapter>, signal: AbortSignal | undefined) =>
            attempt(() => openThroughFirstChunk(adapter, request, signal), signal),
        }
      : {}),
  };
}

/** The `TRequest` an adapter's `send`/`openStream` consume. */
type TRequestOf<A> =
  A extends LanguageModelAdapter<infer _R, infer _C, infer TReq> ? TReq : unknown;

// ============================================================================
// withFallback
// ============================================================================

/** Internal currencies — the serving adapter rides with its raw/chunk. */
interface FallbackRaw {
  readonly adapter: LanguageModelAdapter;
  readonly raw: unknown;
}
interface FallbackChunk {
  readonly adapter: LanguageModelAdapter;
  readonly chunk: unknown;
}

/**
 * Provider failover: try each adapter in order; the next engages when
 * the current one's call / stream-open fails. Never on abort; never
 * mid-stream. Each adapter builds its own params from the canonical
 * input; per-execution serving state is isolated via the accumulator
 * (WeakMap-keyed), so one composite serves concurrent executions.
 *
 * The composite self-describes as the FIRST adapter (`target`,
 * transforms, projection). Compose adapters that share canonical
 * projection; a custom-`project` primary (e.g. anthropic) projects for
 * the whole chain.
 * // TODO(trail-per-serving-transforms): adapterTransforms are compiled
 * // by the consumer before the serving adapter is known — today the
 * // primary's transforms apply chain-wide.
 */
export function withFallback(
  first: LanguageModelAdapter,
  ...rest: readonly LanguageModelAdapter[]
): LanguageModelAdapter<FallbackRaw, FallbackChunk> {
  const chain = [first, ...rest];
  const serving = new WeakMap<StreamAccumulatorView, LanguageModelAdapter>();

  async function tryChain<T>(
    signal: AbortSignal | undefined,
    run: (a: LanguageModelAdapter) => Promise<T>,
  ): Promise<T> {
    let lastCause: unknown;
    for (const a of chain) {
      try {
        return await run(a);
      } catch (cause) {
        if (isAborted(signal, a as LanguageModelAdapter<never, never>, cause)) throw cause;
        lastCause = cause;
      }
    }
    throw lastCause;
  }

  return {
    provider: first.provider,
    target: first.target,
    ...(first.streamByDefault !== undefined ? { streamByDefault: first.streamByDefault } : {}),
    ...(first.customBlocks !== undefined ? { customBlocks: first.customBlocks } : {}),

    // Native requests are provider-specific — defer building to the
    // serving adapter inside send/openStream. The composite's
    // prepareRequest is an identity-stash of the canonical ExecuteInput;
    // each inner adapter runs its OWN prepareRequest on it.
    prepareRequest: (input: ExecuteInput<LanguageModelInput>): unknown => input,

    send: (request, signal) =>
      tryChain<FallbackRaw>(signal, async (a) => {
        const raw = await a.send(
          a.prepareRequest(request as ExecuteInput<LanguageModelInput>),
          signal,
        );
        return { adapter: a, raw };
      }),

    openStream: (request, signal) =>
      tryChain<AsyncIterable<FallbackChunk>>(signal, async (a) => {
        const iter = await openThroughFirstChunk(
          a,
          a.prepareRequest(request as ExecuteInput<LanguageModelInput>),
          signal,
        );
        return (async function* tag(): AsyncIterable<FallbackChunk> {
          for await (const chunk of iter) yield { adapter: a, chunk };
        })();
      }),

    mapChunk: (chunk, accum) => {
      serving.set(accum, chunk.adapter);
      return chunk.adapter.mapChunk(chunk.chunk, accum);
    },

    reconstructRaw: (accum, modelSeen) => {
      const a = serving.get(accum) ?? first;
      return { adapter: a, raw: a.reconstructRaw(accum, modelSeen) };
    },

    finalizeStream: (accum) => {
      const a = serving.get(accum) ?? first;
      return a.finalizeStream ? a.finalizeStream(accum) : defaultFinalizeStream(accum);
    },

    postProcessForNormalize: (raw: FallbackRaw): FallbackRaw =>
      raw.adapter.postProcessForNormalize
        ? { adapter: raw.adapter, raw: raw.adapter.postProcessForNormalize(raw.raw) }
        : raw,

    normalize: (raw: FallbackRaw): LanguageModelExecutionResult => raw.adapter.normalize(raw.raw),

    // Forward the serving adapter's metadata, and stamp the degradation when a
    // non-first adapter served: the executor merges this into the result's
    // `finishMetadata`, which is where an adopter audits (or renders) that a
    // fallback engaged. Absent when the first adapter served — presence IS the
    // signal.
    extractMetadata: (raw: FallbackRaw): Readonly<Record<string, unknown>> | undefined => {
      const inner = raw.adapter.extractMetadata?.(raw.raw);
      if (raw.adapter === first) return inner;
      return {
        ...(inner ?? {}),
        fallback: {
          provider: raw.adapter.provider,
          ...(raw.adapter.target.modelId !== undefined
            ? { modelId: raw.adapter.target.modelId }
            : {}),
          ...(first.target.modelId !== undefined ? { primary: first.target.modelId } : {}),
        },
      };
    },

    ...(first.project ? { project: (input: ProjectInput) => first.project!(input) } : {}),
    ...(first.adapterTransforms
      ? { adapterTransforms: (): readonly DeltaTransform[] => first.adapterTransforms!() }
      : {}),
    isAbortError: (cause) => chain.some((a) => a.isAbortError?.(cause) ?? false),
    ...(first.mapProviderError
      ? {
          mapProviderError: (cause: unknown): ExecuteErrorChannel => first.mapProviderError!(cause),
        }
      : {}),
  };
}

// ============================================================================
// tapModel
// ============================================================================

export interface ModelTap {
  /** Before the provider request (both call and stream open). */
  readonly onCall?: (params: unknown, target: ExecutionTarget) => void;
  /** After normalize — the canonical result. */
  readonly onResult?: (result: LanguageModelExecutionResult) => void;
  /** Each canonical delta produced by mapChunk. */
  readonly onDelta?: (delta: AdapterDelta) => void;
}

/** Observability tap — never alters behavior; tap errors are swallowed. */
export function tapModel<TRaw, TChunk>(
  adapter: LanguageModelAdapter<TRaw, TChunk>,
  tap: ModelTap,
): LanguageModelAdapter<TRaw, TChunk> {
  const safe = (fn?: () => void): void => {
    try {
      fn?.();
    } catch {
      /* taps never break the pipeline */
    }
  };
  return {
    ...adapter,
    send: (request, signal) => {
      safe(() => tap.onCall?.(request, adapter.target));
      return adapter.send(request, signal);
    },
    ...(adapter.openStream !== undefined
      ? {
          openStream: (request: TRequestOf<typeof adapter>, signal: AbortSignal | undefined) => {
            safe(() => tap.onCall?.(request, adapter.target));
            return adapter.openStream!(request, signal);
          },
        }
      : {}),
    mapChunk: (chunk, accum) => {
      const deltas = adapter.mapChunk(chunk, accum);
      if (tap.onDelta) for (const d of deltas) safe(() => tap.onDelta!(d));
      return deltas;
    },
    normalize: (raw) => {
      const result = adapter.normalize(raw);
      safe(() => tap.onResult?.(result));
      return result;
    },
  };
}
