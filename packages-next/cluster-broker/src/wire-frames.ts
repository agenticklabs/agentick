/**
 * Wire frame schema for the broker ↔ client protocol.
 *
 * Discriminated by `type`. Every frame is serialized by the
 * configured `ClusterCodec` (default JSON) and shipped through a
 * `Connection`. The base broker / base client never construct
 * `MessageEnvelope` or `EventEnvelope` wire bytes directly — they
 * always go through one of these frames.
 *
 * Direction conventions (enforced by type guards below, not by tag
 * shape):
 *   - `Client → Broker`: hello, send, broadcast, subscribe-*, unsubscribe
 *   - `Broker → Client`: welcome, membership, inbox-deliver, bus-deliver
 *   - Bidirectional: ping, pong, error, goodbye
 *
 * Reserved namespace: every frame `type` starts with `cluster:` so
 * adopter content (envelope `type` fields) can never collide.
 */

import type { EventEnvelope, MessageEnvelope } from "@agentick/spec-next";
import type { AddressFilter, EventFilter, MembershipChange, NodeId } from "@agentick/cluster-next";
import { isObject } from "@agentick/utils-next";

// ============================================================================
// Frame type constants
// ============================================================================

export const FRAME_HELLO = "cluster:hello";
export const FRAME_WELCOME = "cluster:welcome";
export const FRAME_PING = "cluster:ping";
export const FRAME_PONG = "cluster:pong";
export const FRAME_SEND = "cluster:send";
export const FRAME_BROADCAST = "cluster:broadcast";
export const FRAME_SUBSCRIBE_INBOX = "cluster:subscribe-inbox";
export const FRAME_SUBSCRIBE_BUS = "cluster:subscribe-bus";
export const FRAME_UNSUBSCRIBE = "cluster:unsubscribe";
export const FRAME_INBOX_DELIVER = "cluster:inbox-deliver";
export const FRAME_BUS_DELIVER = "cluster:bus-deliver";
export const FRAME_MEMBERSHIP = "cluster:membership";
export const FRAME_ERROR = "cluster:error";
export const FRAME_GOODBYE = "cluster:goodbye";

// ============================================================================
// Client → Broker frames
// ============================================================================

/**
 * Sent by the client immediately on connection. Identifies the node;
 * the broker uses `nodeId` as the routing key. Once accepted, the
 * broker replies with a `Welcome` frame.
 */
export interface HelloFrame {
  readonly type: typeof FRAME_HELLO;
  readonly nodeId: NodeId;
  /** Reserved for future capability negotiation (codec versions, etc.). */
  readonly capabilities?: Readonly<Record<string, unknown>>;
}

/**
 * Client → Broker: deliver a point-to-point message to a specific
 * node. Broker looks up `toNode` in its routing table and forwards
 * via an `InboxDeliverFrame`.
 */
export interface SendFrame {
  readonly type: typeof FRAME_SEND;
  readonly toNode: NodeId;
  readonly envelope: MessageEnvelope;
}

/**
 * Client → Broker: broadcast an event to every other client. Broker
 * fans out via `BusDeliverFrame` to every connection except the
 * origin (no self-echo per ADR 35 conformance).
 */
export interface BroadcastFrame {
  readonly type: typeof FRAME_BROADCAST;
  readonly envelope: EventEnvelope;
}

/**
 * Client → Broker: register interest in inbox messages matching
 * `filter`. Broker stores the (subId, filter) pair per-connection
 * and applies it on every `SendFrame` it routes to this client.
 *
 * `subId` is caller-allocated; the same id used in
 * `UnsubscribeFrame` cancels the subscription.
 */
export interface SubscribeInboxFrame {
  readonly type: typeof FRAME_SUBSCRIBE_INBOX;
  readonly subId: string;
  readonly filter: AddressFilter;
}

/** Bus equivalent of {@link SubscribeInboxFrame}. */
export interface SubscribeBusFrame {
  readonly type: typeof FRAME_SUBSCRIBE_BUS;
  readonly subId: string;
  readonly filter: EventFilter;
}

/** Cancel a prior subscribe-inbox or subscribe-bus. */
export interface UnsubscribeFrame {
  readonly type: typeof FRAME_UNSUBSCRIBE;
  readonly subId: string;
}

// ============================================================================
// Broker → Client frames
// ============================================================================

/**
 * Broker → Client: handshake-complete acknowledgement. Carries the
 * initial membership snapshot so the client doesn't have to wait for
 * a delta to populate its `nodes()` view.
 */
export interface WelcomeFrame {
  readonly type: typeof FRAME_WELCOME;
  readonly nodes: readonly NodeId[];
}

/** Broker → Client: deliver an inbox message routed to this node. */
export interface InboxDeliverFrame {
  readonly type: typeof FRAME_INBOX_DELIVER;
  readonly envelope: MessageEnvelope;
}

/** Broker → Client: deliver a broadcast event from another node. */
export interface BusDeliverFrame {
  readonly type: typeof FRAME_BUS_DELIVER;
  readonly envelope: EventEnvelope;
}

/** Broker → Client: membership topology delta. */
export interface MembershipFrame {
  readonly type: typeof FRAME_MEMBERSHIP;
  readonly change: MembershipChange;
}

// ============================================================================
// Bidirectional frames
// ============================================================================

/**
 * Either side: liveness probe. The peer replies with a {@link PongFrame}
 * carrying the same `seq`. Three consecutive missed pongs (configurable)
 * is treated as a dead connection.
 */
export interface PingFrame {
  readonly type: typeof FRAME_PING;
  readonly seq: number;
}

export interface PongFrame {
  readonly type: typeof FRAME_PONG;
  readonly seq: number;
}

/**
 * Either side: report an error that doesn't warrant disconnection.
 * Examples: broker rejecting a `SendFrame` for an unknown `toNode`;
 * client receiving a malformed frame.
 *
 * `correlationId` (optional) links the error to a specific frame the
 * peer sent. Currently used only for diagnostic correlation; future
 * versions may add request/response semantics over the wire if
 * needed.
 */
export interface ErrorFrame {
  readonly type: typeof FRAME_ERROR;
  readonly reason: string;
  readonly correlationId?: string;
}

/** Either side: cooperative disconnect notice. The peer SHOULD close after sending/receiving. */
export interface GoodbyeFrame {
  readonly type: typeof FRAME_GOODBYE;
  readonly reason?: string;
}

// ============================================================================
// Discriminated unions
// ============================================================================

export type ClientFrame =
  | HelloFrame
  | SendFrame
  | BroadcastFrame
  | SubscribeInboxFrame
  | SubscribeBusFrame
  | UnsubscribeFrame
  | PingFrame
  | PongFrame
  | ErrorFrame
  | GoodbyeFrame;

export type BrokerFrame =
  | WelcomeFrame
  | InboxDeliverFrame
  | BusDeliverFrame
  | MembershipFrame
  | PingFrame
  | PongFrame
  | ErrorFrame
  | GoodbyeFrame;

export type AnyFrame = ClientFrame | BrokerFrame;

// ============================================================================
// Runtime validators — wire-boundary shape checks
// ============================================================================

/**
 * Tag enumeration enforced against the frame union at compile time.
 * If a new frame is added without updating this list, the initializer
 * fails to compile until the case is added — same pattern as
 * `cluster-next`'s `MESSAGE_HANDLER_ERROR_TAGS`.
 */
const KNOWN_FRAME_TYPES: { readonly [K in AnyFrame["type"]]: true } = {
  [FRAME_HELLO]: true,
  [FRAME_WELCOME]: true,
  [FRAME_PING]: true,
  [FRAME_PONG]: true,
  [FRAME_SEND]: true,
  [FRAME_BROADCAST]: true,
  [FRAME_SUBSCRIBE_INBOX]: true,
  [FRAME_SUBSCRIBE_BUS]: true,
  [FRAME_UNSUBSCRIBE]: true,
  [FRAME_INBOX_DELIVER]: true,
  [FRAME_BUS_DELIVER]: true,
  [FRAME_MEMBERSHIP]: true,
  [FRAME_ERROR]: true,
  [FRAME_GOODBYE]: true,
};

/**
 * Minimal shape check at the wire boundary. Validates ONLY the
 * discriminator + top-level field types — full inner-envelope
 * validation belongs to the `cluster-next` wrappers (which also
 * shape-check before re-appending or dispatching, per Phase 3.2).
 *
 * Defense in depth: bad bytes from a misbehaving wire impl can't
 * confuse the base broker / base client. Anything failing this check
 * emits `cluster:broker:frame-malformed` (broker-side) or
 * `cluster:client:frame-malformed` (client-side) and is dropped.
 */
export function isFrameShape(value: unknown): value is AnyFrame {
  if (!isObject(value)) return false;
  const t = value.type;
  if (typeof t !== "string") return false;
  return Object.hasOwn(KNOWN_FRAME_TYPES, t);
}
