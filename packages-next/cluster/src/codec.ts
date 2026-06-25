/**
 * `ClusterCodec` — wire serialization seam. Sits at the edges of
 * every {@link ClusterTransport} call: transports `encode` envelopes
 * before sending and `decode` on receive. The framework's typed
 * shapes (`MessageEnvelope`, `EventEnvelope`) stay the same;
 * the codec is the swap point for JSON / MessagePack / protobuf /
 * custom wires.
 *
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md §2
 */

import type { EventEnvelope, MessageEnvelope } from "@agentick/spec-next";

/**
 * Wire codec. Adapter authors implement BOTH directions; the
 * framework calls `encode` once per outbound, `decode` once per
 * inbound.
 *
 * The codec speaks bytes (`Uint8Array`) in both directions. Text
 * codecs (JSON) wrap with `TextEncoder` / `TextDecoder` internally:
 *
 *   encode(env) → new TextEncoder().encode(JSON.stringify(env))
 *   decode(raw) → JSON.parse(new TextDecoder().decode(raw))
 *
 * The uniform bytes interface keeps transports simple — TCP, IPC,
 * Redis pub/sub, NATS, WebSocket all speak bytes uniformly with no
 * per-codec branching. Adopters that need debug-friendly inspection
 * decode bytes themselves at observation points (e.g.
 * `new TextDecoder().decode(raw)` if they know the codec is JSON).
 */
export interface ClusterCodec {
  /**
   * Serialize an envelope to bytes for the wire. Adapters MUST NOT
   * mutate `env`. The chosen representation is opaque to the
   * framework — codec + transport pair on both sides MUST agree on
   * the encoding (typically by being the same codec implementation).
   */
  encode(env: MessageEnvelope | EventEnvelope): Uint8Array;

  /**
   * Deserialize wire bytes back into a typed envelope.
   * Implementations MUST reject malformed input — return a parsed
   * envelope OR throw. The framework's cluster layer catches throws
   * and routes them to `cluster:wire:decode-failed` diagnostic
   * events (without crashing the receiver).
   *
   * `decode` does NOT need to discriminate between MessageEnvelope
   * vs EventEnvelope at the codec layer — the framework decides
   * based on which transport channel (`subscribeInbox` vs
   * `subscribeBus`) the bytes arrived on, and casts at the
   * subscription handler.
   */
  decode(raw: Uint8Array): MessageEnvelope | EventEnvelope;
}
