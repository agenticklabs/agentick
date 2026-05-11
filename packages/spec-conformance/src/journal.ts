/**
 * Conformance suite for OperationJournal implementations.
 *
 * Stub: signature only. Bodies populated in Phase 2 of the
 * implementation plan, alongside the MemoryJournal.
 *
 * Invariants the suite will validate (per `19-foundation.md`):
 *
 *   Append/read invariants:
 *     - append(e) makes e visible to read({}, "beginning")
 *     - read order matches append order within a single writer
 *     - tail() yields appended events to live subscribers
 *     - lookupTerminal returns Some(terminal) iff a terminal phase was
 *       appended for that opId
 *     - findOrphaned returns operations with requested but no terminal
 *     - Unknown query fields are ignored, not errors
 *
 *   Idempotency invariants:
 *     - appending the same (opId, phase) twice is a no-op
 *     - lookupTerminal is consistent across reads
 *
 *   Backpressure invariants:
 *     - Bounded queue overflow follows configured strategy without
 *       losing always-journal events
 *     - busOnly events never appear in journal reads
 *     - alwaysJournal events appear in journal reads even under load
 *
 *   Recovery invariants:
 *     - findOrphaned does not return operations with a terminal
 *     - findOrphaned does not return operations newer than threshold
 *
 *   Concurrency invariants:
 *     - Concurrent appends from different writers do not lose events
 *     - Sequence/offset numbering is monotonic per (sessionId)
 */
export function runJournalConformance(
  // factory: () => OperationJournal,  // typed once OperationJournal lands in spec
  _factory: () => unknown,
): void {
  // TODO(phase-2): implement after OperationJournal protocol lands in spec
  // and MemoryJournal is implemented in @agentick/runtime.
  throw new Error("runJournalConformance: not yet implemented (Phase 2)");
}
