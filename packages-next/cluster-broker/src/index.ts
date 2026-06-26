/**
 * `@agentick/cluster-broker-next` — broker-pattern base for cluster
 * transport adapters that run their own broker process.
 *
 * Concrete wire packages subclass:
 *
 *   - `@agentick/cluster-net-next` (Phase 4b/4d) — TCP + Unix socket
 *   - `@agentick/cluster-ws-next`  (Phase 4e)    — WebSocket
 *
 * External-broker adapters (`@agentick/cluster-redis-next`, etc.)
 * are PEERS of this package, not children — Redis IS the broker, so
 * it doesn't reuse this plumbing.
 *
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md §6
 */

// Wire-agnostic primitives — concrete impls subclass these.
export type { Connection, ConnectionCloseReason, Connector, Listener } from "./connection.js";

// Framing helper for byte-stream wires (TCP / Unix socket).
// WebSocket impls skip this and use native message boundaries.
export {
  DEFAULT_MAX_FRAME_BYTES,
  createLengthPrefixedDecoder,
  encodeLengthPrefixed,
  type LengthPrefixedDecodeError,
  type LengthPrefixedDecoder,
  type LengthPrefixedDecoderOptions,
} from "./framing.js";

// Wire frame schema — the protocol every broker subclass speaks.
export {
  FRAME_BROADCAST,
  FRAME_BUS_DELIVER,
  FRAME_ERROR,
  FRAME_GOODBYE,
  FRAME_HELLO,
  FRAME_INBOX_DELIVER,
  FRAME_MEMBERSHIP,
  FRAME_PING,
  FRAME_PONG,
  FRAME_SEND,
  FRAME_SUBSCRIBE_BUS,
  FRAME_SUBSCRIBE_INBOX,
  FRAME_UNSUBSCRIBE,
  FRAME_WELCOME,
  isFrameShape,
  type AnyFrame,
  type BroadcastFrame,
  type BrokerFrame,
  type BusDeliverFrame,
  type ClientFrame,
  type ErrorFrame,
  type GoodbyeFrame,
  type HelloFrame,
  type InboxDeliverFrame,
  type MembershipFrame,
  type PingFrame,
  type PongFrame,
  type SendFrame,
  type SubscribeBusFrame,
  type SubscribeInboxFrame,
  type UnsubscribeFrame,
  type WelcomeFrame,
} from "./wire-frames.js";

// Base classes — wire-impl packages instantiate these.
export { BaseClusterClient, type BaseClusterClientOptions } from "./base-cluster-client.js";
export { BaseBroker, type BaseBrokerOptions } from "./base-broker.js";

// Broker-internal codec adapter (Phase 4f.5). Centralizes the cast
// between adopter-supplied `ClusterCodec` (envelope-typed) and the
// broker's own frame schema. Adopter-invisible by default; advanced
// codec authors implement `BrokerCodec` directly.
export { adaptClusterCodec, type BrokerCodec } from "./broker-codec.js";

// Per-connection bounded write queue (Phase 4f.4). Used internally
// by `BaseBroker` for fan-out; exposed for wire impls that need to
// extend backpressure semantics (e.g., per-frame priorities).
export { BoundedWriteQueue, type BoundedWriteQueueOptions } from "./bounded-write-queue.js";

// Wire-agnostic convenience helpers — shared scaffolding for every
// concrete wire's xBroker / xClusterNode / defineXCluster triple.
export {
  startBroker,
  createClusterNode,
  defineWireCluster,
  type StartBrokerOptions,
  type RunningBroker,
  type CreateClusterNodeOptions,
  type ClusterNodeFactories,
  type DefineWireClusterOptions,
} from "./wire-helpers.js";
