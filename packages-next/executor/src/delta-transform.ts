/**
 * `DeltaTransform` — composable stream transforms in
 * `BaseLanguageModelExecutor`'s pipeline.
 *
 * The full pipeline per streaming call (per chunk):
 *
 *   `mapChunk(chunk)` → adapterTransforms → customBlocks → emit + accumulate
 *
 * Each transform is a stateful object processing one delta at a time
 * (with an end-of-stream `flush` for buffered fragments). Transforms
 * compose by chaining: each transform's output becomes the next
 * transform's input.
 *
 * Common uses:
 *   - **`adapterTransforms`** (provider-internal) — clean up provider-
 *     specific oddities before the rest of the pipeline runs. Example:
 *     OpenAI servers (vLLM, LM Studio, etc.) sometimes inline
 *     `<think>...</think>` tags in `delta.content` instead of using the
 *     standard `reasoning_content` field; an adapter transform
 *     intercepts those and re-routes to reasoning deltas.
 *
 *   - **`customBlocks`** (adopter-declared) — built-in transform driven
 *     by `customBlocks` declared on the executor. Tags become
 *     `custom-block-*` deltas; raw text passes through.
 *
 *   - **adopter-provided** (`deltaTransform` option, future) — markdown
 *     buffering, citation rewriting, latency-shaping, etc.
 *
 * @see docs/proposals/v2/blueprint/06-executor-harness.md
 */

import type { AdapterDelta } from "@agentick/spec-next";

/**
 * A stateful transform applied to `AdapterDelta`s between
 * `mapChunk` and the iterator/bus emit. Transforms compose into a
 * pipeline; each transform processes deltas independently and can
 * emit zero, one, or many deltas in response.
 */
export interface DeltaTransform {
  /**
   * Process a single delta. Return any number of replacement deltas.
   * An empty array suppresses the delta entirely.
   */
  process(delta: AdapterDelta): readonly AdapterDelta[];
  /**
   * End-of-stream flush. Emit any buffered state (partial tags, etc.).
   * Called once at stream completion after the last chunk's deltas
   * have been processed.
   */
  flush(): readonly AdapterDelta[];
}

/**
 * Compose multiple transforms into a single pipeline transform.
 * Deltas flow `transforms[0]` → `transforms[1]` → ... so the first
 * transform sees raw mapChunk output and the last writes to the emit
 * sink.
 *
 * `flush` runs each transform's flush in order; flushed deltas from
 * transform N flow through transforms N+1, N+2, ... — same composition
 * as `process`.
 */
export function composeTransforms(transforms: readonly DeltaTransform[]): DeltaTransform {
  if (transforms.length === 0) return identityTransform();
  if (transforms.length === 1) return transforms[0]!;
  return {
    process(delta: AdapterDelta): readonly AdapterDelta[] {
      let current: readonly AdapterDelta[] = [delta];
      for (const t of transforms) {
        const next: AdapterDelta[] = [];
        for (const d of current) {
          for (const out of t.process(d)) next.push(out);
        }
        current = next;
        if (current.length === 0) return current;
      }
      return current;
    },
    flush(): readonly AdapterDelta[] {
      // Each transform's flush output flows through subsequent
      // transforms' process+flush. Walking the array twice in the
      // worst case is fine for end-of-stream.
      let buffered: readonly AdapterDelta[] = [];
      for (let i = 0; i < transforms.length; i++) {
        const flushed = transforms[i]!.flush();
        if (flushed.length === 0 && buffered.length === 0) continue;
        let routed: readonly AdapterDelta[] = [...buffered, ...flushed];
        for (let j = i + 1; j < transforms.length; j++) {
          const out: AdapterDelta[] = [];
          for (const d of routed) for (const o of transforms[j]!.process(d)) out.push(o);
          routed = out;
        }
        buffered = [...buffered, ...routed];
      }
      return buffered;
    },
  };
}

/** Pass-through transform — never modifies deltas. */
export function identityTransform(): DeltaTransform {
  return {
    process: (delta) => [delta],
    flush: () => [],
  };
}
