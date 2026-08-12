/**
 * `<Compaction>` — declare the fold from the agent tree (ADR 97).
 *
 * The second door. A compaction strategy is configurable where the app is
 * composed:
 *
 * ```ts
 * defineTimeline({ compact: rollingSummary({ keepVerbatim: 6 }) })
 * ```
 *
 * or where the conversation is rendered:
 *
 * ```tsx
 * <Compaction strategy={rollingSummary({ keepVerbatim: 6 })} />
 * ```
 *
 * Tree wins over config while mounted, which is the inner-scope-wins ladder
 * every other layered seam uses.
 *
 * ## This declares; it does not trigger
 *
 * A predecessor of this component watched the token count and called
 * `compact()` itself, and could not have worked: a component runs during the
 * render that produces the prompt whose size it wants to know, so it reads the
 * PREVIOUS request's count — which a fold does not change, because the tick
 * that triggered the fold had already sent the unfolded prompt. It folded the
 * same thread twice.
 *
 * The decision lives in the session's tick-end fold, where the measurement
 * describes the request that just went out and arrives exactly once. What is
 * left for the tree is saying WHICH strategy, which is a declaration.
 */

import * as React from "react";
import { useBridges } from "@agentick/compiler-react";
import type { CompactStrategy } from "@agentick/spec";

export interface CompactionProps {
  readonly strategy: CompactStrategy;
}

export function Compaction({ strategy }: CompactionProps): null {
  const { timeline } = useBridges();
  React.useEffect(() => timeline.declareCompact?.(strategy), [timeline, strategy]);
  return null;
}
