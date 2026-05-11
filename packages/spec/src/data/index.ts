/**
 * Data shapes — wire-format types that cross harness boundaries.
 *
 * Populated incrementally per Phase 1 of the implementation plan.
 *
 * @see docs/proposals/v2/blueprint/02-data-model.md
 */

// Phase 1 deliverables (populated as types land):
//   compiled-structure.ts   CompiledStructure, ContextSpec
//   entries.ts              MessageEntry, SectionEntry
//   declarations.ts         ToolDeclaration, ResourceDeclaration, OutputDeclaration, MCPDeclaration
//   content-blocks.ts       ContentBlock taxonomy + guards (promoted from @agentick/shared)
//   media-source.ts         MediaSource union
//   semantic-node.ts        SemanticNode, SemanticType, SemanticMetadata
//   execution-result.ts     ExecutionResult, ExecutorTerminal, LanguageModelExecutionResult
//   execution-target.ts     ExecutionTarget, LanguageModelTarget
//   execution-deltas.ts     ExecutorDelta
//   events.ts               EventEnvelope, ProtocolEvent, EventQuery, EventSurface
//   messages.ts             MessageEnvelope, MessageAck, MessageHandler
//   outcomes.ts             CommandOutcome, HandlerVerdict
//   channels.ts             ChannelEvent, FrameworkChannels
//   timeline.ts             TimelineEntry
//   knobs.ts                KnobDeclaration, KnobState
//   subscriptions.ts        SubscriptionIntent
//   standard-schema.ts      Inlined StandardSchemaV1
//   compiler-snapshot.ts    CompilerSnapshot, ReactiveCellState, ResolvedValue
//   session-record.ts       SessionRecord
//   journaling-policy.ts    JournalingPolicy, JournalError

export {};
