/**
 * @agentick/runtime-next — in-process substrate.
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
  interceptorKind,
  isOperationSignal,
  liftMiddleware,
  orderInterceptors,
  spanAttributes,
  spanMiddleware,
  runHarnessProtocol,
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
  type ChunkInterceptor,
  type ChunkObserver,
  type ChunkTransform,
  type CommandHooks,
  type CommandMiddlewares,
  type HookRegistrars,
  type CommandRegistry,
  type GuardDecider,
  type HarnessFx,
  type HarnessShell,
  type InterceptorKind,
  type Middleware,
  type OperationSignal,
  type StreamCommand,
  type Unsubscribe,
} from "./substrate/base-harness.js";
export {
  EMPTY_CONTEXT,
  RuntimeContextRef,
  getContext,
  readContext,
  withContext,
  type RuntimeContext,
  type RuntimeContextUser,
} from "./substrate/runtime-context.js";
export { matchesQuery, compileQuery, type CompiledMatcher } from "./substrate/query.js";
export { resolveSyncSubstrateSlot } from "./substrate/resolve-slot.js";
export { ulid } from "./substrate/ulid.js";
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
