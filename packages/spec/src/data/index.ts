/**
 * Data shapes — wire-format types that cross harness boundaries.
 *
 * Phase 1a–b landed (events, outcomes, operations, inbox, errors,
 * journaling-policy, standard-schema). Phase 1c (this batch) adds the
 * compiler-facing types needed to unblock Phase 3:
 *
 *   - content-blocks.ts   ContentBlock taxonomy (promoted from @agentick/shared), CacheHint
 *   - semantic.ts         SemanticNode, SemanticMetadata, SemanticContentBlock
 *   - formatter.ts        FormatterRef, FormatInput, FormatResult, FormatScope, FormatTrace
 *   - entries.ts          MessageEntry, MessageMetadata, ContextSpec
 *   - declarations.ts     ToolDeclaration, ResourceDeclaration, OutputDeclaration, MCPDeclaration
 *   - rendered-tree.ts    RenderedTree, SpecConfig, ProviderClientOptions, ProviderOptions, ProviderToolOptions, ModelSelection
 *   - execution-result.ts ExecutionResult, ExecutorTerminal, LanguageModelExecutionResult, ExecutorDelta
 *   - execution-target.ts ExecutionTarget, LanguageModelTarget, TargetCapabilities, MediaSupport, MediaSourceKind
 *
 * Still pending (later phases):
 *   - timeline.ts          TimelineEntry
 *   - knobs.ts             KnobDeclaration, KnobState
 *   - subscriptions.ts     SubscriptionIntent
 *   - compiler-diagnostics.ts  diagnostics + subscription intents
 *   - session-record.ts    SessionRecord
 *
 * @see docs/proposals/v2/blueprint/02-data-model.md
 */

export * from "./events.js";
export * from "./runtime-context.js";
export * from "./outcomes.js";
export * from "./operations.js";
export * from "./inbox.js";
export * from "./errors.js";
export * from "./journaling-policy.js";
export * from "./standard-schema.js";

export * from "./content-blocks.js";
export * from "./tool-span.js";
export * from "./signals.js";
export * from "./observability.js";
export * from "./ops.js";
export * from "./channels.js";
export * from "./session-status-channel.js";
export * from "./timeline.js";
export * from "./streaming.js";
export * from "./semantic.js";
export * from "./formatter.js";
export * from "./entries.js";
export * from "./message-source.js";
export * from "./declarations.js";
export * from "./structured-output.js";
export * from "./rendered-tree.js";
export * from "./execution-result.js";
export * from "./execution-target.js";
export * from "./model-facts.js";
export * from "./usage-cost.js";
export * from "./compiler-diagnostics.js";
export * from "./tool-handler.js";
export * from "./tool-result.js";
export * from "./tool-output-bound.js";
export * from "./validator.js";
export * from "./sandbox.js";
export * from "./mcp.js";
export * from "./media.js";
