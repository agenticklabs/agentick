/**
 * `@agentick/client-core` — canonical TypeScript client implementation
 * of agentick's `ClientProtocol`.
 *
 * Runs in every JS runtime (Node, browser, Bun, Deno, edge) — no
 * DOM-specific assumptions. Transports are pluggable via
 * `ClientTransport` (defined in `@agentick/spec/client`).
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

export {
  createClient,
  DEFAULT_HANDSHAKE_RETRY_POLICY,
  type CreateClientOptions,
  type HandshakeRetryPolicy,
} from "./client.js";
export { composeRequest, composeSubscribe } from "./pipeline.js";
export { ClientHandlerRegistry } from "./handler-registry.js";
export { commandForMethod } from "./hook-keys.js";
export { effectMiddleware, type EffectRequestMiddleware } from "./effect-middleware.js";
export { clientRuntimeContext } from "./runtime-context.js";
export { clientObservability, type ClientObservability } from "./observability.js";
export { makeAppHandle, makeGatewayHandle, makeSessionHandle } from "./handles.js";
export {
  onLog,
  onProgress,
  type OnSignalOptions,
  type ReceivedLog,
  type ReceivedProgress,
} from "./signals.js";
// ── KIT TIER (extension-author) — the low-level client-side fold engine ──────
// B2 slice 4 DEMOTION: `channelView` / `eventView` / `channelStream` /
// `eventStream` / `liveStore` are the fold machinery HARNESS packages build their
// read views on (knobs/tasks fold with `channelView`; elicitation/timeline with
// `liveStore` + `eventStream`). They are NOT the everyday app surface — an app
// reads state through a handle's `list()`/`subscribe()`/`view(opts)`, never by
// wiring a `channelView` itself. They stay exported for the extension-author /
// headless-composition case; the blessed path is the handle.
// TODO(slice-5-sweep): move these behind a `@agentick/client-core/kit`
// subpath (or `/internal`) once the ~4 harness `/client` imports are migrated in
// one coordinated sweep — deferred here to keep this slice's blast radius small.
export { eventView, type EventViewConfig } from "./event-view.js";
export { eventStream, type EventClient } from "./event-stream.js";
export { liveStore, type LiveStore } from "./live-store.js";
export { channelView, type ChannelView, type ChannelViewConfig } from "./channel-view.js";
export { channelStream, type ChannelStream, type ChannelClient } from "./channel-stream.js";
export {
  foldProgress,
  progressView,
  type ProgressState,
  type ProgressStates,
} from "./progress-view.js";
export {
  knownSessionHandleExtensionImports,
  registerSessionHandleExtension,
  registeredSessionHandleExtensions,
  SessionSubHandleNotRegistered,
  type SessionSubHandleFactory,
  type SessionSubHandleOptions,
  type SessionSubHandleTeardown,
} from "./session-handle-extensions.js";
export { makeWireNamespace, wireFallthrough, type WireCallClient } from "./wire-namespace.js";
export {
  isClientHandle,
  isEnumerable,
  isRespondable,
  type ClientHandle,
  type Enumerable,
  type Respondable,
} from "./handle-contract.js";
export { polledView, type PolledView, type PolledViewConfig } from "./polled-view.js";
export {
  filteredView,
  type CollectionViewSource,
  type FilteredView,
  type FilteredViewOptions,
} from "./view-source.js";

// Re-export protocol types adopters need to write extensions, for the
// "one import" ergonomic. Spec is the canonical source.
export type {
  Client,
  ClientAuthSurface,
  ClientEvent,
  ClientEventFilter,
  ClientEventSurface,
  ClientExtension,
  ClientHookContext,
  ClientHooks,
  ClientInstaller,
  ClientLifecycleEvents,
  ClientNamespaces,
  ClientProtocol,
  ClientRegistrars,
  ClientState,
  ClientTransport,
  EventFrame,
  LifecycleEventSpec,
  LifecycleHandlerFor,
  ProgressStream,
  RequestInput,
  RequestMiddleware,
  SubscribeInput,
  SubscribeMiddleware,
  SubscriptionStream,
  TransportCapabilities,
  TransportError,
} from "@agentick/spec";
