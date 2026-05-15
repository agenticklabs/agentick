/**
 * Data shapes — wire-format types that cross harness boundaries.
 *
 * Phase 1a–b landed. Phase 1+ will add:
 *   - content-blocks.ts  ContentBlock taxonomy (promoted from @agentick/shared)
 *   - compiled-structure.ts  CompiledStructure, ContextSpec, MessageEntry, SectionEntry
 *   - declarations.ts  ToolDeclaration, ResourceDeclaration, OutputDeclaration, MCPDeclaration
 *   - semantic-node.ts  SemanticNode, SemanticType, SemanticMetadata
 *   - execution-result.ts  ExecutionResult, ExecutorTerminal, LanguageModelExecutionResult
 *   - execution-target.ts  ExecutionTarget, LanguageModelTarget
 *   - execution-deltas.ts  ExecutorDelta
 *   - render.ts  FormatterRef, FormatInput, FormatResult, FormattableContent, FormatScope, FormatTrace
 *   - channels.ts  FrameworkChannels and concrete channel payloads
 *   - timeline.ts  TimelineEntry
 *   - knobs.ts  KnobDeclaration, KnobState
 *   - subscriptions.ts  SubscriptionIntent
 *   - reconciler-snapshot.ts  ReconcilerSnapshot
 *   - session-record.ts  SessionRecord
 *
 * @see docs/proposals/v2/blueprint/02-data-model.md
 */

export * from "./events.js";
export * from "./outcomes.js";
export * from "./operations.js";
export * from "./inbox.js";
export * from "./errors.js";
export * from "./journaling-policy.js";
export * from "./standard-schema.js";
