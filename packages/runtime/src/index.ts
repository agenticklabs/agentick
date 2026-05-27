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

export { MemoryJournal } from "./substrate/memory-journal.js";
export { LocalEventBus } from "./substrate/local-event-bus.js";
export { LocalInbox } from "./substrate/local-inbox.js";
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
  type Middleware,
  type LifecycleHandler,
  type Unsubscribe,
} from "./substrate/base-harness.js";
export {
  EMPTY_CONTEXT,
  RuntimeContextRef,
  getContext,
  withContext,
  type RuntimeContext,
} from "./substrate/runtime-context.js";
export { matchesQuery } from "./substrate/query.js";
export { ulid } from "./substrate/ulid.js";
export {
  RequestResponseRegistry,
  type RegisterOptions,
  type RegisteredRequest,
  type RequestError,
} from "./substrate/request-response-registry.js";

// Callback-style factory for the reconciler protocol (FAÇADE.6).
// Reconciler-agnostic — lives here in runtime alongside BaseHarness so
// callers can wire any reconciler (React, Angular, custom) without
// depending on @agentick/reconciler-react.
export { defineReconciler, type DefineReconcilerInput } from "./define-reconciler.js";
