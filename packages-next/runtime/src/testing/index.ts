/**
 * `@agentick/runtime-next/testing` — substrate test doubles.
 *
 * The FAKE tier is the production in-memory substrate itself — import
 * `LocalInbox` / `LocalEventBus` / `MemoryJournal` from the package
 * root (real routing, real semantics; Meszaros fakes). This subpath
 * holds the STUB/SPY tier: canned answers + call recording, no
 * routing. Doubles are typed against spec interfaces so spec changes
 * break stale doubles at compile time.
 */

export { stubInbox, type StubInboxCall, type StubInboxOptions } from "./stub-inbox.js";
