/**
 * Type guards for `@agentick/spec` data shapes.
 *
 * Zero runtime cost beyond a property check. Used to narrow union
 * types at the consumer level (`isTextBlock(block)` narrows
 * `ContentBlock` to `TextBlock`, etc.).
 *
 * Strict runtime validation (with issue collection, error paths) lives
 * separately in `@agentick/spec-validator` (opt-in, ajv-backed) — out
 * of scope for these guards.
 *
 * @see docs/proposals/v2/blueprint/02-data-model.md
 * @see docs/proposals/v2/blueprint/20-pluggability-charter.md §Validation
 */

import type {
  AudioBlock,
  CodeBlock,
  CodeExecutionResultBlock,
  ContentBlock,
  ContextEntry,
  CsvBlock,
  CustomContentBlock,
  DataBlock,
  DocumentBlock,
  EventBlock,
  EventEnvelope,
  EventPhase,
  ExecutableCodeBlock,
  ExecutionResult,
  ExecutorError,
  ExecutorTerminal,
  GeneratedFileBlock,
  GeneratedImageBlock,
  HtmlBlock,
  ImageBlock,
  JsonBlock,
  LifecycleError,
  LifecycleEvent,
  LifecycleExecutionEnd,
  LifecycleExecutionStart,
  LifecycleTickEnd,
  LifecycleTickStart,
  MediaBlock,
  MessageEntry,
  ProtocolEvent,
  ReasoningBlock,
  RenderedTree,
  SectionEntry,
  SpecFeatureName,
  StateChangeBlock,
  SystemEventBlock,
  TerminalEvent,
  TextBlock,
  ToolBlock,
  ToolResultBlock,
  ToolUseBlock,
  UserActionBlock,
  VideoBlock,
  XmlBlock,
} from "../index.js";

// ============================================================================
// ContentBlock — narrow on the `type` discriminator
// ============================================================================

export function isTextBlock(b: ContentBlock): b is TextBlock {
  return b.type === "text";
}
export function isReasoningBlock(b: ContentBlock): b is ReasoningBlock {
  return b.type === "reasoning";
}
export function isImageBlock(b: ContentBlock): b is ImageBlock {
  return b.type === "image";
}
export function isDocumentBlock(b: ContentBlock): b is DocumentBlock {
  return b.type === "document";
}
export function isAudioBlock(b: ContentBlock): b is AudioBlock {
  return b.type === "audio";
}
export function isVideoBlock(b: ContentBlock): b is VideoBlock {
  return b.type === "video";
}
export function isToolUseBlock(b: ContentBlock): b is ToolUseBlock {
  return b.type === "tool_use";
}
export function isToolResultBlock(b: ContentBlock): b is ToolResultBlock {
  return b.type === "tool_result";
}
export function isJsonBlock(b: ContentBlock): b is JsonBlock {
  return b.type === "json";
}
export function isXmlBlock(b: ContentBlock): b is XmlBlock {
  return b.type === "xml";
}
export function isCsvBlock(b: ContentBlock): b is CsvBlock {
  return b.type === "csv";
}
export function isHtmlBlock(b: ContentBlock): b is HtmlBlock {
  return b.type === "html";
}
export function isCodeBlock(b: ContentBlock): b is CodeBlock {
  return b.type === "code";
}
export function isGeneratedImageBlock(b: ContentBlock): b is GeneratedImageBlock {
  return b.type === "generated_image";
}
export function isGeneratedFileBlock(b: ContentBlock): b is GeneratedFileBlock {
  return b.type === "generated_file";
}
export function isExecutableCodeBlock(b: ContentBlock): b is ExecutableCodeBlock {
  return b.type === "executable_code";
}
export function isCodeExecutionResultBlock(b: ContentBlock): b is CodeExecutionResultBlock {
  return b.type === "code_execution_result";
}
export function isUserActionBlock(b: ContentBlock): b is UserActionBlock {
  return b.type === "user_action";
}
export function isSystemEventBlock(b: ContentBlock): b is SystemEventBlock {
  return b.type === "system_event";
}
export function isStateChangeBlock(b: ContentBlock): b is StateChangeBlock {
  return b.type === "state_change";
}
export function isCustomBlock(b: ContentBlock): b is CustomContentBlock {
  return b.type === "custom";
}

// Block-category guards
export function isMediaBlock(b: ContentBlock): b is MediaBlock {
  return (
    b.type === "image" || b.type === "document" || b.type === "audio" || b.type === "video"
  );
}
export function isToolBlock(b: ContentBlock): b is ToolBlock {
  return b.type === "tool_use" || b.type === "tool_result";
}
export function isDataBlock(b: ContentBlock): b is DataBlock {
  return (
    b.type === "json" ||
    b.type === "xml" ||
    b.type === "csv" ||
    b.type === "html" ||
    b.type === "code"
  );
}
export function isEventBlock(b: ContentBlock): b is EventBlock {
  return (
    b.type === "user_action" || b.type === "system_event" || b.type === "state_change"
  );
}

// ============================================================================
// ContextEntry — narrow on the `kind` discriminator
// ============================================================================

export function isMessageEntry(e: ContextEntry): e is MessageEntry {
  return e.kind === "message";
}
export function isSectionEntry(e: ContextEntry): e is SectionEntry {
  return e.kind === "section";
}

// ============================================================================
// EventEnvelope / ProtocolEvent — phase + outcome narrowing
// ============================================================================

export function isPhase<P extends EventPhase>(
  event: ProtocolEvent,
  phase: P,
): event is ProtocolEvent & { readonly phase: P } {
  return event.phase === phase;
}
export function isRequestedEvent(event: ProtocolEvent): event is EventEnvelope {
  return event.phase === "requested";
}
export function isBeforeEvent(event: ProtocolEvent): event is EventEnvelope {
  return event.phase === "before";
}
export function isDeltaEvent(event: ProtocolEvent): event is EventEnvelope {
  return event.phase === "delta";
}
export function isTerminalEvent(event: ProtocolEvent): event is EventEnvelope {
  return event.phase === "terminal";
}

/**
 * Combined phase + outcome guards — narrow to terminal events with a
 * specific outcome (e.g., `isSucceededTerminal(event)` narrows to
 * `{ phase: "terminal"; outcome: "succeeded" }`).
 */
export function isSucceededTerminal(
  event: ProtocolEvent,
): event is EventEnvelope & { readonly phase: "terminal"; readonly outcome: "succeeded" } {
  return event.phase === "terminal" && event.outcome === "succeeded";
}
export function isFailedTerminal(
  event: ProtocolEvent,
): event is EventEnvelope & { readonly phase: "terminal"; readonly outcome: "failed" } {
  return event.phase === "terminal" && event.outcome === "failed";
}

// ============================================================================
// TerminalEvent — narrow on outcome
// ============================================================================

export function isSucceeded<R>(
  t: TerminalEvent<R>,
): t is { readonly outcome: "succeeded"; readonly result: R } {
  return t.outcome === "succeeded";
}
export function isFailed<R, E>(
  t: TerminalEvent<R, E>,
): t is { readonly outcome: "failed"; readonly error: E } {
  return t.outcome === "failed";
}
export function isCanceled<R, E>(
  t: TerminalEvent<R, E>,
): t is { readonly outcome: "canceled"; readonly reason?: string } {
  return t.outcome === "canceled";
}
export function isVetoed<R, E>(
  t: TerminalEvent<R, E>,
): t is { readonly outcome: "vetoed"; readonly reason?: string } {
  return t.outcome === "vetoed";
}
export function isReplaced<R, E>(
  t: TerminalEvent<R, E>,
): t is { readonly outcome: "replaced"; readonly result: R; readonly reason?: string } {
  return t.outcome === "replaced";
}
export function isDeferred<R, E>(
  t: TerminalEvent<R, E>,
): t is { readonly outcome: "deferred"; readonly retryAfter?: number } {
  return t.outcome === "deferred";
}

// ============================================================================
// ExecutorTerminal — narrow on outcome (no "deferred" — defer is a
// pre-execution handler verdict, not a terminal outcome for executors)
// ============================================================================

export function isExecutorSucceeded<R extends ExecutionResult>(
  t: ExecutorTerminal<R>,
): t is { readonly outcome: "succeeded"; readonly result: R } {
  return t.outcome === "succeeded";
}
export function isExecutorFailed<R extends ExecutionResult>(
  t: ExecutorTerminal<R>,
): t is { readonly outcome: "failed"; readonly error: ExecutorError } {
  return t.outcome === "failed";
}

// ============================================================================
// LifecycleEvent — narrow on kind
// ============================================================================

export function isLifecycleTickStart(e: LifecycleEvent): e is LifecycleTickStart {
  return e.kind === "tick-start";
}
export function isLifecycleTickEnd(e: LifecycleEvent): e is LifecycleTickEnd {
  return e.kind === "tick-end";
}
export function isLifecycleExecutionStart(e: LifecycleEvent): e is LifecycleExecutionStart {
  return e.kind === "execution-start";
}
export function isLifecycleExecutionEnd(e: LifecycleEvent): e is LifecycleExecutionEnd {
  return e.kind === "execution-end";
}
export function isLifecycleError(e: LifecycleEvent): e is LifecycleError {
  return e.kind === "error";
}

// ============================================================================
// RenderedTree — feature detection
// ============================================================================

/**
 * Returns true when `tree.features` includes `feature`. Returns false
 * when `features` is undefined (an absent features list is treated as
 * "no features declared").
 */
export function hasFeature(tree: RenderedTree, feature: SpecFeatureName): boolean {
  return tree.features?.includes(feature) ?? false;
}
