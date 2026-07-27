/**
 * Re-export of the canonical `ulid()` from `@agentick/utils` so
 * existing `@agentick/runtime` consumers (LocalInbox, MemoryJournal) keep
 * their import path. The impl lives in `@agentick/utils` to keep it
 * available to framework-substrate-agnostic packages (`@agentick/cluster`,
 * adapter packages, transports) without depending on `@agentick/runtime`.
 */

export { ulid } from "@agentick/utils";
