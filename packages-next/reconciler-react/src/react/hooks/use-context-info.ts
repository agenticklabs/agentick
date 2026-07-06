/**
 * `useContextInfo` — real-time context-window utilization for JSX
 * components (adaptive-headroom patterns: compact/summarize as the
 * window fills). Closes the v1 `useContextInfo` gap (#204).
 *
 * ## Data source
 *
 * A pure READER over the lifecycle carrier. Lifecycle events are the
 * spec's "carriers of state that user-supplied hooks need to observe";
 * their `metadata` bag is the open-ended extension slot. This hook
 * registers `useOnTickEnd` + `useOnExecutionEnd` and reads the latest:
 *
 *   - `usedTokens`     ← `metadata.usage.inputTokens` (the last
 *                        tick's / turn's input tokens; UsageStats is
 *                        stamped by the loop→reconciler lifecycle bridge)
 *   - `contextWindow`  ← `metadata.contextWindow` (pre-resolved
 *                        session-side via `effectiveModelInfo(target,
 *                        registry)` — see the STOP note below)
 *
 * `utilization` is the `usedTokens / contextWindow` ratio in `[0, 1]`,
 * computed inline so this hook stays dependency-free (no `@agentick/
 * model-next` runtime dep). It mirrors `contextUtilization` from
 * model-next; the trivial ratio isn't worth a cross-package dep,
 * especially while `contextWindow` isn't threaded yet (below).
 *
 * ## STOP-and-report: `contextWindow` plumbing is Wave 2
 *
 * The `ExecutionTarget` (and any adopter `ModelRegistry`) does NOT reach
 * the reconciler mount today: it lives on the session harness but is not
 * threaded onto `SessionBridge`, `MountInput`, `RenderTreeInput`, or the
 * lifecycle event types (all reconciler-reachable surfaces carry no
 * typed target). The v2-correct wiring mirrors v1 (`Session.
 * broadcastContextInfo` → `compiler.contextInfoStore`): the session —
 * which owns the target + adopter registry — resolves
 * `effectiveModelInfo(target, registry)` and stamps
 * `{ usage, contextWindow }` into the lifecycle event's `metadata` bag
 * (or a dedicated bridge). That producer spans `@agentick/spec-next` +
 * `@agentick/session-next` and is out of scope for this wave.
 *
 * Until then this hook reports whatever the carrier provides: with no
 * producer stamping `metadata`, it returns `{ usedTokens: 0 }` and an
 * undefined window/utilization. It lights up the moment the producer
 * lands — no hook change required.
 *
 * // TODO(wave-2): session-side producer stamps resolved
 * // { usage, contextWindow } (via effectiveModelInfo(target, registry))
 * // onto the tick-end / execution-end lifecycle metadata so this hook
 * // yields a live window + utilization.
 *
 * @see packages/core/src/hooks/context-info.ts (v1 prior art)
 * @see packages-next/model/src/model-info.ts (contextUtilization / effectiveModelInfo)
 */

import { useState } from "react";
import type { LifecycleExecutionEnd, LifecycleTickEnd, UsageStats } from "@agentick/spec-next";
import { useOnExecutionEnd } from "./use-on-execution-end.js";
import { useOnTickEnd } from "./use-on-tick-end.js";

export interface ContextInfo {
  /** Model context window in tokens; `undefined` when unknown. */
  readonly contextWindow?: number;
  /** Input tokens consumed by the last observed tick / turn. */
  readonly usedTokens: number;
  /** `usedTokens / contextWindow`, clamped to `[0, 1]`; `undefined` with no window. */
  readonly utilization?: number;
}

/** Lifecycle `metadata` slice this hook reads (the open-ended carrier). */
interface ContextMetadata {
  readonly usage?: UsageStats;
  readonly contextWindow?: number;
}

function readMetadata(
  event: LifecycleTickEnd | LifecycleExecutionEnd,
): ContextMetadata | undefined {
  return event.metadata as ContextMetadata | undefined;
}

export function useContextInfo(): ContextInfo {
  const [info, setInfo] = useState<ContextInfo>({ usedTokens: 0 });

  const observe = (event: LifecycleTickEnd | LifecycleExecutionEnd): void => {
    const meta = readMetadata(event);
    if (!meta) return;
    const usedTokens = meta.usage?.inputTokens ?? 0;
    const contextWindow = meta.contextWindow;
    const utilization =
      contextWindow && contextWindow > 0
        ? Math.min(1, Math.max(0, usedTokens / contextWindow))
        : undefined;
    setInfo((prev) => {
      if (
        prev.usedTokens === usedTokens &&
        prev.contextWindow === contextWindow &&
        prev.utilization === utilization
      ) {
        return prev; // no-op: avoid a re-render churn cycle
      }
      return contextWindow !== undefined
        ? { usedTokens, contextWindow, ...(utilization !== undefined ? { utilization } : {}) }
        : { usedTokens };
    });
  };

  useOnTickEnd(observe);
  useOnExecutionEnd(observe);

  return info;
}
