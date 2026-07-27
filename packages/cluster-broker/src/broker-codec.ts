/**
 * `BrokerCodec` — the broker package's view of an adapter's
 * `ClusterCodec`. Same wire bytes, narrower type contract specific
 * to broker-internal frames (`BrokerFrame` instead of
 * `MessageEnvelope | EventEnvelope`).
 *
 * The story: at the @agentick/cluster layer, `ClusterCodec` advertises
 * envelope-only encode/decode. That's correct for adopters
 * constructing envelopes — the narrow type catches misuse at
 * construction sites. But the broker piggybacks the SAME codec to
 * serialize Hello / Welcome / Subscribe / SubscribeAck / Membership
 * / etc. frames over the same wire. JSON encodes anything; msgpack
 * /protobuf would need a broker-specific schema.
 *
 * Rather than spreading `frame as unknown as MessageEnvelope` casts
 * across the broker codebase, the cast is centralized HERE: one
 * adapter, one cast, one place to fix when an adopter ships a typed
 * codec that needs a real broker schema.
 *
 * Phase 4f.5 lands this as the architectural placeholder. Phase 5+
 * — when a real msgpack/protobuf codec adopter appears — promotes
 * `BrokerCodec` from a thin adapter to a first-class interface
 * adopters implement directly, with their own broker-frame schema.
 */

import type { ClusterCodec } from "@agentick/cluster";
import type { MessageEnvelope } from "@agentick/spec";

import type { AnyFrame } from "./wire-frames.js";

/**
 * Broker-internal codec. Encodes any wire frame — `BrokerFrame`
 * (broker-emitted: Hello/Welcome/SubscribeAck/...) OR `ClientFrame`
 * (client-emitted: Hello/Send/Subscribe/...) — to bytes. Decodes
 * bytes to a shape-unchecked value (callers verify via
 * `isFrameShape`). The shared wire carries both directions; the
 * codec doesn't distinguish at the bytes level.
 */
export interface BrokerCodec {
  encode(frame: AnyFrame): Uint8Array;
  decode(bytes: Uint8Array): unknown;
}

/**
 * Adapt an adopter-supplied `ClusterCodec` (typed for envelopes) into
 * a `BrokerCodec` (typed for broker frames). The one cast lives here.
 *
 * TODO(phase-5): when a typed codec (msgpack/protobuf) adopter
 * arrives, replace this adapter with a real `BrokerCodec`
 * implementation that knows the broker frame schema. The
 * `BaseBroker` + `BaseClusterClient` already speak `BrokerCodec`, so
 * the upgrade is transparent to them.
 */
export function adaptClusterCodec(codec: ClusterCodec): BrokerCodec {
  return {
    encode: (frame) => codec.encode(frame as unknown as MessageEnvelope),
    decode: (bytes) => codec.decode(bytes),
  };
}
