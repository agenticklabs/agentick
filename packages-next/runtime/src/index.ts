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
  HandlerRegistry,
  MiddlewareChain,
  OperationOutcomeError,
  mergeVerdict,
  runHarnessProtocol,
  type BaseHarnessOptions,
  type HarnessShell,
  type Middleware,
  type LifecycleHandler,
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
  RequestResponseRegistry,
  type RegisterOptions,
  type RegisteredRequest,
  type RequestError,
} from "./substrate/request-response-registry.js";
export { busAsyncIterator } from "./substrate/bus-async-iterator.js";
