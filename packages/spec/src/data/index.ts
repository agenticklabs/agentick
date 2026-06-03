/**
 * Data shapes — wire-format types that cross harness boundaries.
 *
 * Phase 1a–b landed (events, outcomes, operations, inbox, errors,
 * journaling-policy, standard-schema). Phase 1c (this batch) adds the
 * reconciler-facing types needed to unblock Phase 3:
 *
 *   - content-blocks.ts   ContentBlock taxonomy (promoted from @agentick/shared)
 *   - semantic.ts         SemanticNode, SemanticMetadata, SemanticContentBlock
 *   - formatter.ts        FormatterRef, FormatInput, FormatResult, FormatScope, FormatTrace
 *   - entries.ts          ContextEntry, MessageEntry, SectionEntry, CacheHint
 *   - declarations.ts     ToolDeclaration, ResourceDeclaration, OutputDeclaration, MCPDeclaration
 *   - rendered-tree.ts    RenderedTree, SpecConfig, ProviderClientOptions, ProviderOptions, ProviderToolOptions, ModelSelection
 *   - execution-result.ts ExecutionResult, ExecutorTerminal, LanguageModelExecutionResult, ExecutorDelta
 *   - execution-target.ts ExecutionTarget, LanguageModelTarget, TargetCapabilities
 *
 * Still pending (later phases):
 *   - channels.ts          FrameworkChannels and concrete channel payloads
 *   - timeline.ts          TimelineEntry
 *   - knobs.ts             KnobDeclaration, KnobState
 *   - subscriptions.ts     SubscriptionIntent
 *   - reconciler-snapshot.ts ReconcilerSnapshot
 *   - session-record.ts    SessionRecord
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

export * from "./content-blocks.js";
export * from "./streaming.js";
export * from "./semantic.js";
export * from "./formatter.js";
export * from "./entries.js";
export * from "./declarations.js";
export * from "./rendered-tree.js";
export * from "./execution-result.js";
export * from "./execution-target.js";
export * from "./reconciler-snapshot.js";
export * from "./tool-handler.js";
export * from "./validator.js";
export * from "./sandbox.js";
export * from "./mcp.js";
