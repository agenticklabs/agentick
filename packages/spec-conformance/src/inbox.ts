/**
 * Conformance suite for MessageInbox implementations.
 *
 * Stub: signature only. Bodies populated in Phase 2.
 *
 * Invariants the suite will validate:
 *   - register/send round-trip with typed handler dispatch
 *   - tell vs ask semantics
 *   - messageId idempotency cache (same messageId → cached result)
 *   - AskTimeout fires for unresponsive remote handlers
 *   - AddressNotFound for unknown addresses
 *   - Local and cluster routing are observationally indistinguishable
 *     for handlers
 */
export function runInboxConformance(
  // factory: () => MessageInbox,  // typed once MessageInbox lands in spec
  _factory: () => unknown,
): void {
  // TODO(phase-2): implement after MessageInbox protocol lands in spec
  // and LocalInbox is implemented in @agentick/runtime.
  throw new Error("runInboxConformance: not yet implemented (Phase 2)");
}
