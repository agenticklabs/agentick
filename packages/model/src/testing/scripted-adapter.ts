/**
 * `scriptedAdapter` — the canonical scripted `LanguageModelAdapter`
 * double (Meszaros stub tier). Replaces the per-spec locals that had
 * accumulated in `@agentick/app` / `@agentick/model` tests.
 *
 * Round trip: `prepareRequest` is identity (and records the input);
 * `send` returns the scripted text; `openStream` yields the scripted
 * chunks; `normalize` produces one text block. Optional failure
 * scripting covers retry/failover tests. Built through the blessed
 * {@link defineLanguageModelAdapter} factory — the same composition point
 * the shipped adapters use.
 */

import type { AdapterDelta, ExecutionTarget } from "@agentick/spec";

import {
  defineLanguageModelAdapter,
  type LanguageModelAdapter,
  type StreamAccumulatorView,
} from "../language-model-adapter.js";
import { thinkTagTransform } from "../tag-transforms.js";

export interface ScriptedAdapterOptions {
  /** Observability identity + default modelId stem. Default "scripted". */
  readonly provider?: string;
  /** Chunks for the streaming path. Default: `text` split in two. */
  readonly chunks?: readonly string[];
  /**
   * Fail the first N `call`/`openStream` starts (shared counter) with
   * `cause()` — default a 429-shaped Error. Covers withRetry /
   * withFallback semantics.
   */
  readonly failures?: number;
  readonly cause?: () => unknown;
  /** Prefix the normalized output with `${provider}:` — lets failover
   *  tests assert WHICH adapter's normalize ran. Default false. */
  readonly tagOutput?: boolean;
  /** Wire `thinkTagTransform()` as the adapter transform. */
  readonly thinkTags?: boolean;
  readonly target?: ExecutionTarget;
}

export interface ScriptedAdapter extends LanguageModelAdapter<{ text: string }, string> {
  /** Total send/openStream attempts (including scripted failures). */
  calls(): number;
  /** The last projected `LanguageModelInput` prepareRequest received. */
  seenParams(): unknown;
}

export function scriptedAdapter(
  text: string,
  options: ScriptedAdapterOptions = {},
): ScriptedAdapter {
  const provider = options.provider ?? "scripted";
  const chunks = options.chunks ?? [text.slice(0, 2), text.slice(2)].filter((c) => c.length > 0);
  const failures = options.failures ?? 0;
  const cause = options.cause ?? (() => Object.assign(new Error("rate limited"), { status: 429 }));
  const target: ExecutionTarget = options.target ?? {
    kind: "language-model",
    provider,
    modelId: `${provider}-v1`,
    capabilities: { supportsTools: false, supportsStreaming: true, supportsJsonSchema: true },
  };
  let attempts = 0;
  let seen: unknown;

  const base = defineLanguageModelAdapter<{ text: string }, string, unknown>({
    provider,
    target,
    prepareRequest: (input) => {
      // Record the projected `LanguageModelInput` (seenParams' historical
      // contract) and use it as the identity "native request" — the scripted
      // `send`/`openStream` ignore the request, so identity is sufficient.
      seen = input.targetInput;
      return input.targetInput;
    },
    send: async () => {
      if (attempts++ < failures) throw cause();
      return { text };
    },
    openStream: async function* (): AsyncIterable<string> {
      if (attempts++ < failures) throw cause();
      yield* chunks;
    } as unknown as NonNullable<LanguageModelAdapter<{ text: string }, string>["openStream"]>,
    mapChunk: (chunk, accum: StreamAccumulatorView): readonly AdapterDelta[] => [
      ...(accum.textByBlock.has(0)
        ? []
        : ([{ type: "content-start", blockIndex: 0, blockType: "text" }] as const)),
      { type: "content-delta", blockIndex: 0, delta: chunk },
    ],
    reconstructRaw: (accum) => ({ text: accum.totalText() }),
    normalize: (raw) => ({
      specVersion: "2026-05-08",
      output: [{ type: "text", text: options.tagOutput ? `${provider}:${raw.text}` : raw.text }],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }),
    ...(options.thinkTags ? { adapterTransforms: () => [thinkTagTransform()] } : {}),
  });

  // Spread the frozen factory result into a fresh object carrying the
  // test-double introspection methods (`calls` / `seenParams`).
  return { ...base, calls: () => attempts, seenParams: () => seen };
}
