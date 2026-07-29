/**
 * `generate()` / `generateStream()` — standalone single-shot helpers
 * (ADR 52).
 *
 * Drive a `LanguageModelAdapter` directly: no harness, no substrate,
 * no Effect. One model call in, one `LanguageModelExecutionResult`
 * out. These are NOT a loop — tool calls come back in the result for
 * the caller to dispatch (the executor harness + session own looped
 * execution).
 *
 * ```ts
 * import { generate } from "@agentick/model";
 * import { openai } from "@agentick/model-openai";
 *
 * const result = await generate({
 *   model: openai("gpt-4o"),
 *   messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
 * });
 * ```
 *
 * `generateStream` mirrors the executor's streaming fold exactly —
 * mapChunk → transform pipeline → synthetic message-start guard →
 * accumulator apply — so the delta vocabulary observed here is
 * identical to what `app.events({ surface: "model" })` carries.
 *
 * **No provider-request hooks here (by design).** These helpers call the
 * adapter's `prepareRequest` → `send` / `openStream` DIRECTLY — no harness,
 * no command system. The `onBefore/AfterModelProviderRequest` boundary
 * hooks and the `onModelProviderRequestChunk` raw-chunk interceptor are
 * minted by the executor's nested `model:provider-request` command and
 * therefore fire ONLY on the executor path (`LanguageModelExecutor` →
 * `session.send` / the loop). Wiring them here would require dragging in
 * the command system, defeating the whole point of a zero-Effect
 * standalone helper. Adopters who need last-mile request interception use
 * the executor, or compose an adapter with {@link tapModel} for a
 * non-interceptor observability tap.
 *
 * @see docs/proposals/v2/blueprint/52-executors-and-model-adapters.md
 */

import type {
  AdapterDelta,
  ExecutionTarget,
  LanguageModelExecutionResult,
  LanguageModelInput,
  LanguageModelMessage,
  LanguageModelParameters,
  LanguageModelTool,
} from "@agentick/spec";
import { omitUndefined } from "@agentick/utils";

import { defaultFinalizeStream, type LanguageModelAdapter } from "./language-model-adapter.js";
import { composeTransforms, type DeltaTransform } from "./delta-transform.js";
import { StreamAccumulator } from "./stream-accumulator.js";
import { customBlockTransform } from "./tag-transforms.js";
import { applyMediaSupport } from "./media-support.js";

/** Options bag shared by `generate` and `generateStream`. */
export interface GenerateOptions<TRaw = unknown, TChunk = unknown> {
  /** The provider adapter — `openai("gpt-4o")`, `anthropic(...)`, ... */
  readonly model: LanguageModelAdapter<TRaw, TChunk>;
  /** Canonical ordered messages (system messages inline). */
  readonly messages: ReadonlyArray<LanguageModelMessage>;
  /** Tools advertised to the model. Calls come back unexecuted. */
  readonly tools?: ReadonlyArray<LanguageModelTool>;
  /** Generation parameters (temperature, maxOutputTokens, ...). */
  readonly parameters?: LanguageModelParameters;
  /** Abort the in-flight provider call. */
  readonly signal?: AbortSignal;
}

/** Handle returned by `generateStream`. */
export interface GenerateStreamHandle {
  /**
   * The canonical delta stream — same vocabulary the executor harness
   * emits (`message-start`, `content-delta`, `tool-call-*`, `usage`,
   * `message-end`, `message`).
   */
  readonly stream: AsyncIterable<AdapterDelta>;
  /**
   * The normalized single-shot result. Resolves after `stream` has
   * been fully consumed (the fold needs every delta); rejects if the
   * provider stream throws.
   */
  readonly result: Promise<LanguageModelExecutionResult>;
}

/**
 * Build the canonical input, screening media against what the adapter's target
 * declares it can carry.
 *
 * This path never runs `project`, so it screens here — the executor does the same
 * thing at its own `projectImpl`. Both are framework-owned; an adapter has no way
 * to skip either, which is the whole reason the decision was taken out of the
 * adapters' own `switch` arms.
 */
function toInput(
  options: GenerateOptions<unknown, unknown>,
  target: ExecutionTarget,
): LanguageModelInput {
  const { messages } = applyMediaSupport(options.messages, target);
  return {
    messages,
    ...omitUndefined({ tools: options.tools, parameters: options.parameters }),
  };
}

/**
 * One non-streaming provider call: buildParams → call →
 * postProcessForNormalize → normalize. Provider errors propagate
 * as-is — there is no harness error channel at this layer.
 */
export async function generate<TRaw, TChunk>(
  options: GenerateOptions<TRaw, TChunk>,
): Promise<LanguageModelExecutionResult> {
  const adapter = options.model;
  const request = adapter.prepareRequest({
    targetInput: toInput(options, adapter.target),
    target: adapter.target,
  });
  let raw: TRaw = await adapter.send(request, options.signal);
  if (adapter.postProcessForNormalize) raw = adapter.postProcessForNormalize(raw);
  return adapter.normalize(raw);
}

/**
 * One streaming provider call. Deltas flow through the adapter's
 * transform pipeline and the shared accumulator; the final result is
 * synthesized from accumulated state exactly as the executor does
 * (reconstructRaw → postProcessForNormalize → normalize).
 */
export function generateStream<TRaw, TChunk>(
  options: GenerateOptions<TRaw, TChunk>,
): GenerateStreamHandle {
  const adapter = options.model;
  let resolveResult!: (r: LanguageModelExecutionResult) => void;
  let rejectResult!: (cause: unknown) => void;
  const result = new Promise<LanguageModelExecutionResult>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });
  // The consumer may abandon the stream on error without ever awaiting
  // `result` — keep that from surfacing as an unhandled rejection.
  result.catch(() => {});

  async function* run(): AsyncGenerator<AdapterDelta, void, undefined> {
    try {
      if (!adapter.openStream) {
        throw new Error(
          `adapter '${adapter.provider}' does not support streaming — use generate() instead`,
        );
      }
      const request = adapter.prepareRequest({
        targetInput: toInput(options, adapter.target),
        target: adapter.target,
      });
      const iter = await adapter.openStream(request, options.signal);

      const accum = new StreamAccumulator();
      const transforms: DeltaTransform[] = [...(adapter.adapterTransforms?.() ?? [])];
      if (adapter.customBlocks) transforms.push(customBlockTransform(adapter.customBlocks));
      const pipeline = composeTransforms(transforms);

      // Synthetic message-start guard — mirror the executor: providers
      // that carry their own message-start pass through; otherwise a
      // minimal one is injected before the first delta.
      let messageStartEmitted = false;
      const withStart = (delta: AdapterDelta): readonly AdapterDelta[] => {
        if (messageStartEmitted || delta.type === "message-start") {
          messageStartEmitted = true;
          return [delta];
        }
        messageStartEmitted = true;
        return [{ type: "message-start", role: "assistant" }, delta];
      };

      function* dispatch(deltas: readonly AdapterDelta[]): Generator<AdapterDelta> {
        for (const transformed of deltas) {
          for (const delta of withStart(transformed)) {
            accum.apply(delta);
            yield delta;
          }
        }
      }

      for await (const chunk of iter) {
        for (const mapped of adapter.mapChunk(chunk, accum)) {
          yield* dispatch(pipeline.process(mapped));
        }
      }
      yield* dispatch(pipeline.flush());
      const finalize = adapter.finalizeStream
        ? adapter.finalizeStream(accum)
        : defaultFinalizeStream(accum);
      yield* dispatch(finalize);

      let raw = adapter.reconstructRaw(accum, accum.modelSeen);
      if (adapter.postProcessForNormalize) raw = adapter.postProcessForNormalize(raw);
      resolveResult(adapter.normalize(raw));
    } catch (cause) {
      rejectResult(cause);
      throw cause;
    }
  }

  return { stream: run(), result };
}
