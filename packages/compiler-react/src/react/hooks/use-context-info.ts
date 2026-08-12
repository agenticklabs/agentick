/**
 * `useContextInfo` — real-time context-window utilization for JSX
 * components (adaptive-headroom patterns: compact/summarize as the
 * window fills). Closes the v1 `useContextInfo` gap (#204).
 *
 * ## Data source
 *
 * This hook merges the seam's two channels (ADR 54 / 55):
 *
 *   - `contextWindow`  ← the synchronous {@link RenderContext} envelope
 *                        (`renderContext.contextInfo`), resolved
 *                        session-side via `effectiveModelInfo(target,
 *                        registry)` — see the render-input note below.
 *   - `usedTokens`     ← the async lifecycle bridge: registers
 *                        `useOnTickEnd` + `useOnExecutionEnd` and reads
 *                        the latest `metadata.usage.inputTokens` (the
 *                        prior tick's / turn's input tokens; UsageStats
 *                        is stamped by the loop→compiler bridge).
 *   - `estimated`      ← the same bridge's `metadata.estimate`, measured
 *                        by the executor off the projection it sent. What
 *                        it adds over `usedTokens` is the SPLIT between
 *                        conversation and tool schemas, which no provider
 *                        reports and which a caller acting on one of them
 *                        needs.
 *
 * `utilization` is the `usedTokens / contextWindow` ratio in `[0, 1]`,
 * computed inline so this hook stays dependency-free (no `@agentick/
 * model-next` runtime dep). It mirrors `contextUtilization` from
 * model-next; the trivial ratio isn't worth a cross-package dep.
 *
 * ## The window is a synchronous render input (ADR 54 / 55)
 *
 * The active model's `contextWindow` rides the {@link RenderContext}
 * envelope (`renderContext.contextInfo`), NOT the async lifecycle bridge:
 * the session — which owns the target + injected `models` registry —
 * resolves `effectiveModelInfo(target, registry)` per render and threads
 * it through the loop into `renderTree({ renderContext })`; the compiler
 * provides it via `RenderContextContext`, and this hook reads it
 * synchronously so adaptive-compaction components react to the window
 * WHILE producing the IR. `usedTokens` is a past fact — it rides the async
 * tick-end / execution-end bridge (one-tick-behind is correct).
 *
 * @example
 * // Adaptive compaction: render less as the window fills.
 * const { utilization = 0 } = useContextInfo();
 * const kept = entries.slice(-(utilization > 0.8 ? 5 : 50));
 *
 * @see docs/proposals/v2/blueprint/55-render-context-seam.md
 * @see packages/core/src/hooks/context-info.ts (v1 prior art)
 * @see packages/model/src/model-info.ts (contextUtilization / effectiveModelInfo)
 */

import { useContext, useState } from "react";
import type {
  LifecycleExecutionEnd,
  LifecycleTickEnd,
  TokenEstimate,
  UsageStats,
} from "@agentick/spec";
import { useOnExecutionEnd } from "./use-on-execution-end.js";
import { useOnTickEnd } from "./use-on-tick-end.js";
import { RenderContextContext } from "../render-context-context.js";

export interface ContextInfo {
  /** Model context window in tokens; `undefined` when unknown. */
  readonly contextWindow?: number;
  /** Input tokens consumed by the last observed tick / turn. */
  readonly usedTokens: number;
  /** `usedTokens / contextWindow`, clamped to `[0, 1]`; `undefined` with no window. */
  readonly utilization?: number;
  /**
   * The last request's cost as measured locally, split into conversation and
   * tool schemas — the breakdown no provider reports.
   *
   * Read this, not {@link usedTokens}, when the answer drives an action on one
   * part of the request. `estimated.tools` is billed on every call and cannot
   * be reduced by compacting; treating the two as one number is how a fold
   * trigger ends up firing at something folding cannot fix.
   *
   * Absent until a tick has been measured, and — like `usedTokens` — describes
   * the PREVIOUS request. A component cannot measure the tree it is part of.
   */
  readonly estimated?: TokenEstimate;
}

/** Lifecycle `metadata` slice this hook reads (the open-ended carrier). */
interface ContextMetadata {
  readonly usage?: UsageStats;
  readonly estimate?: TokenEstimate;
  readonly contextWindow?: number;
}

function readMetadata(
  event: LifecycleTickEnd | LifecycleExecutionEnd,
): ContextMetadata | undefined {
  return event.metadata as ContextMetadata | undefined;
}

export function useContextInfo(): ContextInfo {
  // The CURRENT render's window is a synchronous render input (ADR 54 /
  // 55) — read it from the RenderContext envelope, not an async lifecycle
  // setState (which races the compiler's sync render and never reaches
  // this IR). `contextInfo` is the seeded foundational slot.
  const rendered = useContext(RenderContextContext)?.contextInfo;
  const [observed, setObserved] = useState<{
    usedTokens: number;
    estimated?: TokenEstimate;
  }>({ usedTokens: 0 });

  // MERGE, not replace: `contextWindow` rides the RenderContext envelope
  // (synchronous — live DURING this render, read above; a changed window
  // reaches adaptive-compaction components before the IR freezes).
  // `usedTokens` is a PAST fact — it arrives at tick-END / execution-END
  // via the async lifecycle bridge (the prior turn's consumed tokens;
  // one-tick-behind is correct). Each updates its own field; utilization
  // recomputes from the merged pair.
  const observe = (event: LifecycleTickEnd | LifecycleExecutionEnd): void => {
    const metadata = readMetadata(event);
    const used = metadata?.usage?.inputTokens;
    const estimated = metadata?.estimate;
    if (used === undefined && estimated === undefined) return;
    setObserved((prev) => {
      const next = {
        usedTokens: used ?? prev.usedTokens,
        ...((estimated ?? prev.estimated) ? { estimated: estimated ?? prev.estimated } : {}),
      };
      return next.usedTokens === prev.usedTokens && next.estimated === prev.estimated ? prev : next;
    });
  };
  useOnTickEnd(observe);
  useOnExecutionEnd(observe);

  // Merge: render-context (current window + optional session-provided
  // usedTokens) over the async-observed usedTokens.
  const contextWindow = rendered?.contextWindow;
  const usedTokens = rendered?.usedTokens ?? observed.usedTokens;
  const utilization =
    contextWindow && contextWindow > 0
      ? Math.min(1, Math.max(0, usedTokens / contextWindow))
      : undefined;
  const estimated = observed.estimated;
  return {
    usedTokens,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(utilization !== undefined ? { utilization } : {}),
    ...(estimated !== undefined ? { estimated } : {}),
  };
}
