/**
 * `@agentick/timeline-next/react` — React bindings for TimelineHarness.
 *
 * Per ADR 27, the React surface for a harness lives in its own /react
 * subpath. Adopters using `@agentick/reconciler-react-next` import the
 * hooks and components from here.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

// Side-effect import — registers the HookBridges.timeline slot.
import "../augment.js";

export { useTimeline } from "./use-timeline.js";
export {
  Timeline,
  type TimelineProps,
  type TimelineRenderFn,
  type ConversationHistoryOptions,
  type TimelineBudgetOptions,
} from "./timeline.js";
export { Transcript, type TranscriptProps } from "./transcript.js";
export {
  compactEntries,
  getEntryTokens,
  type CompactionStrategy,
  type CompactionFunction,
  type CompactionResult,
  type CompactOptions,
  type CompactResult,
  type TokenBudgetInfo,
} from "./token-budget.js";
