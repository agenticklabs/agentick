/**
 * @agentick/runtime — in-process substrate.
 *
 * Exposes:
 *   - MemoryJournal      (OperationJournal impl)
 *   - LocalEventBus      (EventBus impl)
 *   - LocalInbox         (MessageInbox impl)
 *   - BaseHarness        (inheritance point for concrete harnesses)
 *   - Small utilities (id generator, query matcher)
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md
 */

export { MemoryJournal, type MemoryJournalOptions } from "./substrate/memory-journal.js";
export {
  LocalEventBus,
  DEFAULT_LOCAL_BUS_BATCH_POLICY,
  DEFAULT_LOCAL_BUS_RETENTION,
  type LocalEventBusOptions,
} from "./substrate/local-event-bus.js";
export { LocalInbox, type LocalInboxOptions } from "./substrate/local-inbox.js";
export {
  LocalChannelPublisher,
  type LocalChannelPublisherOptions,
} from "./substrate/local-channel-publisher.js";
export {
  BaseHarness,
  inheritedFrom,
  MiddlewareChain,
  OperationOutcomeError,
  OperationVeto,
  OperationDefer,
  OperationReplace,
  annotateOperationSpan,
  composeMiddleware,
  deriveChunkHookName,
  deriveHookNames,
  hooksToMiddlewares,
  chunkCarrier,
  readChunkCarrier,
  guardsToMiddlewares,
  commandGuardMiddleware,
  qualifyNamespaceGuards,
  qualifyNamespaceHooks,
  interceptorKind,
  isOperationSignal,
  liftMiddleware,
  orderInterceptors,
  spanAttributes,
  spanMiddleware,
  runHarnessProtocol,
  runHarnessProtocolOn,
  runHarnessStream,
  createCommandRunner,
  createOperationRunner,
  scopeToCommand,
  signalFromVerdict,
  tagInterceptor,
  withCallMiddleware,
  type CommandRunner,
  type CommandRunnerDeps,
  type CommandDef,
  type StreamCommandDef,
  type RegisteredCommand,
  type CommandInvokeOpts,
  type OperationRunner,
  type OperationRunnerDeps,
  type RunOperation,
  type AsyncMiddleware,
  type AsyncStream,
  type AfterHook,
  type SpanAttributes,
  type BaseHarnessOptions,
  type BeforeHook,
  type ChunkCarrier,
  type ChunkInterceptor,
  type ChunkObserver,
  type ChunkTransform,
  type CommandGuards,
  type CommandHooks,
  type CommandMiddlewares,
  type HookRegistrars,
  type CommandRegistry,
  type GuardDecider,
  type HarnessInterceptors,
  type NamespaceGuards,
  type NamespaceHooks,
  type HarnessFx,
  type HarnessShell,
  // The ctx EVERY hook/guard/middleware receives. `CommandHooks` is typed
  // against it, so writing a hook as a standalone named function (rather than
  // inline in the bag, where it is inferred) is impossible without it.
  type InterceptorCtx,
  type InterceptorKind,
  type Middleware,
  type OperationSignal,
  type PendingRequestSnapshot,
  type StreamCommand,
  type Unsubscribe,
} from "./substrate/base-harness.js";
export {
  EMPTY_CONTEXT,
  BoundaryFacetsRef,
  RuntimeContextRef,
  getBoundaryFacets,
  getContext,
  readContext,
  withBoundaryFacets,
  withContext,
  type RuntimeContext,
  type RuntimeContextUser,
} from "./substrate/runtime-context.js";
export {
  deriveObservability,
  NOOP_SPAN,
  OFF_TRACE,
  NOOP_METRICS,
  type MetricSink,
  type TelemetryProvider,
  type TelemetryRuntime,
  type DeriveObservabilityDeps,
} from "./substrate/observability.js";
export { deriveOps, type DeriveOpsDeps, type RunOperationFn } from "./substrate/ops.js";
export { deriveContext, type ContextFacets } from "./substrate/derive-context.js";
// ADR 93 — the top-level namespace-slot registry (the runtime half of the
// slots law; the type half is `NamespaceSlots` augmentation in spec).
export {
  registerNamespaceSlot,
  registeredNamespaceSlots,
  collectNamespaceSlots,
  namespaceSlotExtensions,
  type NamespaceSlotToExtension,
} from "./substrate/namespace-slots.js";
export { matchesQuery, compileQuery, type CompiledMatcher } from "./substrate/query.js";
export { resolveSyncSubstrateSlot } from "./substrate/resolve-slot.js";
// Convenience re-export for harness authors, who mint opIds constantly. The
// SEAM (`setIdGenerator`) is deliberately not re-exported — installing a
// generator is a process-wide startup decision, and it should be reached for
// at its own address rather than found incidentally on the runtime barrel.
export { generateId } from "@agentick/utils";
export {
  SESSION_ESCALATION_MESSAGE_TYPE,
  ESCALATION_TIMEOUT_MS,
  type SessionEscalationMessageType,
  type EscalationEnvelopePayload,
  type EscalationHop,
  type EscalationOutcome,
  type EscalationInterceptor,
} from "./substrate/escalation-protocol.js";
export {
  SESSION_TASK_WAKE_MESSAGE_TYPE,
  TASK_WAKE_SOURCE,
  type SessionTaskWakeMessageType,
  type TaskWakeSource,
  type SessionTaskWakePayload,
} from "./substrate/task-wake-protocol.js";
export {
  RequestResponseRegistry,
  type RegisterOptions,
  type RegisteredRequest,
  type RequestError,
} from "./substrate/request-response-registry.js";
export { busAsyncIterator } from "./substrate/bus-async-iterator.js";
export { forkBusSubscription } from "./substrate/fork-bus-subscription.js";
