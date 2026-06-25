/**
 * Re-export of the canonical `ulid()` from `@agentick/utils-next` so
 * existing runtime-next consumers (LocalInbox, MemoryJournal) keep
 * their import path. The impl lives in utils-next to keep it
 * available to framework-substrate-agnostic packages (cluster-next,
 * adapter packages, transports) without depending on runtime-next.
 */

export { ulid } from "@agentick/utils-next";
