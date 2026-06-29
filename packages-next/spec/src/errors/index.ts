/**
 * `@agentick/spec-next/errors` — v2 typed-error infrastructure.
 *
 * Foundation for ADR 41. This barrel exports:
 *
 *   - `AgentickError` (abstract root + `SerializedAgentickError` wire
 *     shape + `isAgentickError` predicate)
 *   - `registerAgentickError` / `lookupAgentickError` — class registry
 *     keyed by `_tag`
 *   - `serializeAgentickError` / `deserializeAgentickError` — JSON
 *     codec round-trip
 *   - `UnknownAgentickError` — fallback for unregistered tags
 *
 * Concrete error classes (per-domain abstract intermediates +
 * leaf classes) land in subsequent commits and re-export from this
 * barrel. This commit lands the base machinery only — no consumer
 * package's error types have been migrated yet.
 *
 * @see docs/proposals/v2/blueprint/41-error-hierarchy.md
 */

export {
  AgentickError,
  type AgentickErrorOptions,
  type AgentickErrorTag,
  type SerializedAgentickError,
  isAgentickError,
} from "./base.js";

export {
  type ConcreteAgentickErrorClass,
  registerAgentickError,
  lookupAgentickError,
  _clearAgentickErrorRegistry,
  _registeredAgentickErrorTags,
} from "./registry.js";

export { deserializeAgentickError, serializeAgentickError } from "./codec.js";

export { UnknownAgentickError } from "./unknown.js";

export {
  AddressNotFound,
  AskTimeout,
  HandlerError,
  InboxClosed,
  InboxError,
  type InboxErrorChannel,
  InvalidPayload,
  JournalError,
  type JournalErrorChannel,
  LifecycleHandlerError,
  MessageHandlerError,
  type MessageHandlerErrorChannel,
  OffsetOutOfRange,
  ReadFailed,
  RoutingFailed,
  WriteFailed,
} from "./substrate.js";

export {
  AppAlreadyExistsError,
  AppClosedError,
  AppError,
  type AppErrorChannel,
  AppExecutionFailed,
  AppNotFoundError,
  ChannelError,
  ExecutionFailed,
  GatewayClosedError,
  GatewayError,
  type GatewayErrorChannel,
  GatewayLifecycleError,
  KnobError,
  SessionAlreadyExistsError,
  SessionBusyError,
  SessionClosedError,
  SessionError,
  type SessionErrorChannel,
  SessionNotFoundError,
  SessionTimelineError,
  type StateApplyError,
  type StateApplyErrorChannel,
  TimelineWriteFailed,
} from "./lifecycle.js";

export {
  AlreadyMounted,
  BridgeUnavailable,
  CompactHandlerFailed,
  DataFetchFailed,
  ExecuteError,
  type ExecuteErrorChannel,
  ExecutionError,
  FormatterFailed,
  GroupEmpty,
  GroupTypeMismatch,
  InvalidDispatchInput,
  InvalidElement,
  KnobsError,
  type KnobsErrorChannel,
  LoopCanceledError,
  LoopExecutorError,
  type LoopExecutorErrorChannel,
  MaxIterationsExceeded,
  MaxTicksExceeded,
  ElicitError,
  type ElicitErrorChannel,
  ElicitationCancelled,
  ElicitationDeclined,
  ElicitationNotSupported,
  McpServerAuthRejected,
  McpServerAuthzDenied,
  McpServerClosed,
  McpServerConfigInvalid,
  McpServerConnectionRejected,
  McpServerError,
  type McpServerErrorChannel,
  McpServerNotFound,
  McpServerRateLimited,
  McpServerTransportFailed,
  UrlElicitationRequired,
  type UrlElicitationSpec,
  NormalizationFailed,
  NotMounted,
  PromptAlreadyExists,
  PromptArgumentInvalid,
  PromptArgumentMissing,
  PromptMissingContent,
  PromptNotFound,
  PromptRenderFailed,
  PromptsBackendError,
  ProjectionFailed,
  PromptsError,
  type PromptsErrorChannel,
  ProviderAborted,
  ProviderRejected,
  ProviderTimeout,
  ReconcileError,
  type ReconcileErrorChannel,
  RehydrateStrategyMissing,
  RenderFailed,
  SkillAlreadyExists,
  SkillNotFound,
  SkillsBackendError,
  SkillsError,
  type SkillsErrorChannel,
  SnapshotIncompatible,
  StreamFailed,
  TickError,
  TimelineError,
  type TimelineErrorChannel,
  ToolAbortedError,
  ToolAlreadyRegistered,
  ToolConfirmationDeniedError,
  ToolConfirmationTimeoutError,
  ToolExecutorError,
  type ToolExecutorErrorChannel,
  ToolHandlerError,
  ToolHandlerMissing,
  ToolNotFoundError,
  ToolPermissionError,
  ToolTaskModeConflictError,
  ToolTimeoutError,
  ToolValidationError,
  UnknownExecutorError,
  UnknownKnob,
  UnstableTree,
  ValidationFailed,
  type ExecutorErrorChannel,
} from "./harnesses.js";

export {
  ChannelPublishError,
  type ChannelPublishErrorChannel,
  ChannelPublisherClosed,
  ChannelSequenceOverflow,
  McpClientError,
  type McpClientErrorChannel,
  McpClientNotReadyError,
  McpRemoteTaskNonCompletedError,
  McpTransportError,
  SandboxConnectionError,
  SandboxError,
  type SandboxErrorChannel,
  SandboxEscapeError,
  SandboxExecError,
  SandboxIoError,
  SandboxMountError,
  SandboxPermissionDeniedError,
  SandboxResourceLimitError,
  UnknownTaskError,
} from "./remaining.js";
