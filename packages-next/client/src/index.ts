/**
 * `@agentick/client-next` — canonical TypeScript client implementation
 * of agentick's `ClientProtocol`.
 *
 * Runs in every JS runtime (Node, browser, Bun, Deno, edge) — no
 * DOM-specific assumptions. Transports are pluggable via
 * `ClientTransport` (defined in `@agentick/spec-next/client`).
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

export { createClient, type CreateClientOptions } from "./client.js";
export { composeRequest, composeSubscribe } from "./pipeline.js";
export { ClientHandlerRegistry } from "./handler-registry.js";
export { effectMiddleware, type EffectRequestMiddleware } from "./effect-middleware.js";
export { makeAppHandle, makeGatewayHandle, makeSessionHandle } from "./handles.js";
export {
  onLog,
  onProgress,
  type OnSignalOptions,
  type ReceivedLog,
  type ReceivedProgress,
} from "./signals.js";
export { channelView, type ChannelView, type ChannelViewConfig } from "./channel-view.js";

// Re-export protocol types adopters need to write extensions, for the
// "one import" ergonomic. Spec is the canonical source.
export type {
  Client,
  ClientAuthSurface,
  ClientEvent,
  ClientEventFilter,
  ClientEventSurface,
  ClientExtension,
  ClientInstaller,
  ClientLifecycleEvents,
  ClientNamespaces,
  ClientProtocol,
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
} from "@agentick/spec-next";
