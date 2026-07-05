# ADR 53 Wave 1 — working list (delete when Wave 1 lands)

Branch: timeline-immediate-fixes (PR #196). Spec union DONE (TimelineEntry =
MessageTimelineEntry | TurnBoundaryEntry; SessionMessageMetadata blessed keys
executionId/tickId/usage) — compiled clean workspace-wide, zero ripple.

## Remaining, in order

1. **timeline harness** (packages-next/timeline/src/harness.ts):
   - DELETE: `_pending`, `queueCmd`/`drainCmd` declarations (timeline:queue,
     timeline:drain at ~227-236), `queueBody`/`drainBody` (~539-606),
     `readPending()` (~293), pending notify plumbing.
   - ADD: `committedOffset` maintained as index into `_persisted` (recomputed
     in `hydrate()` by scanning for last `kind==="boundary" &&
     outcome==="succeeded"`; advanced when a succeeded boundary is appended).
   - ADD: `unconsumedInput(): readonly MessageTimelineEntry[]` — entries
     after offset matching `isInputEntry` (kind message && role user;
     named const).
   - ADD: `endTurn(input: { executionId; outcome; usage? }): { hadUnconsumed:
     boolean }` — THE ATOMIC CHECK-AND-APPEND: synchronously (no await before
     the memory mutation) check unconsumedInput(); if outcome==="succeeded"
     and unconsumed EMPTY → append TurnBoundaryEntry (ts: Date.now(),
     visibility "log") and advance offset, return {hadUnconsumed:false}; if
     unconsumed non-empty → DO NOT append, return {hadUnconsumed:true} (loop
     continues); failed/aborted outcomes ALWAYS append boundary (attempt is a
     fact) without advancing offset. Appends ride applyAppend (memory sync +
     write-behind pump).
2. **timeline handle** (handle.ts): delete readPending/queue/drain; add
   `unconsumedInput()` + `endTurn()`. Update noopTimelineHandle in
   packages-next/session/src/define-session.ts.
3. **spec protocol timeline-harness.ts**: delete TimelineQueueInput/
   TimelineQueueResult/TimelineDrainResult/PendingEntry + queue/drain from
   TimelineHarnessProtocol; keep the ADR53-corrected docs.
4. **session harness** (packages-next/session/src/harness.ts):
   - sendBody: replace queueInputMessage+drain (lines ~768,775,1054-1063)
     with direct `appendMessageEntry` per input message (visibility model,
     metadata: {} — input has no execution provenance until consumed).
   - applyExecutorResultBody (~1004): stamp metadata {executionId, tickId,
     usage: result.usage} on the assistant entry.
   - applyToolResultsBody (~1018): stamp {executionId, tickId}.
   - Terminal path (after loop returns, near flush ~872): call
     `timeline.endTurn({executionId, outcome, usage: aggregate})`.
   - Tick-end decision (TickEndForwardDecision producer — find
     notifyTickEnd handling): return {kind:"continue"} when
     timeline.unconsumedInput().length > 0 after a non-tool_use tick;
     integrate with endTurn's hadUnconsumed (loop asks via decision).
   - JOIN semantics: `send()` while an execution runs → append messages +
     return the RUNNING execution's handle (ratified). Find the in-flight
     execution registry in session harness.
5. **loop-executor**: verify TickEndForwardDecision is consumed for
   continuation (loop-executor/src/harness.ts) — wire if only plumbed.
6. **VERB-MATRIX.md**: remove timeline:queue/drain rows (note ADR 53).
7. **Tests**: timeline harness queue/drain specs → rewrite as
   endTurn/offset/unconsumed specs (atomicity, failed-no-advance, hydrate
   fold recompute); session inbox-routing tests for queue/drain verbs
   DELETE; add steering test (send during execution → joined handle +
   continuation); run.spec + durability spec unaffected (append path).
8. Wave 2/3 delegation AFTER Wave 1 green (Timeline above-offset rendering,
   readPending client consumers, docs).

House rules: bare git commit (NEVER pipe), commitlint body ≤100 chars/line,
unfiltered grep sweep for deleted identifiers (PendingEntry,
TimelineQueueInput, readPending, timeline:queue, timeline:drain).
