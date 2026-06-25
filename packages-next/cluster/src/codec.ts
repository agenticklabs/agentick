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
 * The return type of `encode` is `Uint8Array | string` so binary
 * codecs (MessagePack, protobuf, FlatBuffers) and text codecs (JSON)
 * coexist. Transports MUST handle either — most adapters do
 * `if (typeof raw === "string") ... else ...` once at the IO
 * boundary and never branch again.
 */
export interface ClusterCodec {
  /**
   * Serialize an envelope to bytes/string for the wire. Adapters
   * MUST NOT mutate `env`. The chosen representation is opaque to
   * the framework — codec + transport pair on both sides MUST agree
   * on the encoding (typically by being the same codec
   * implementation).
   */
  encode(env: MessageEnvelope | EventEnvelope): Uint8Array | string;

  /**
   * Deserialize wire bytes/string back into a typed envelope.
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
  decode(raw: Uint8Array | string): MessageEnvelope | EventEnvelope;
}
