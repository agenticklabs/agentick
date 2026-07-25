/**
 * `@agentick/client-extensions/offline` — offline-queue extension.
 *
 * Buffers outbound RPCs when the wire is closed; replays FIFO when
 * the transport state transitions back to "open". Pluggable durable
 * store; per-method queueable policy.
 *
 * Same family as Workbox BackgroundSync, Apollo Link Queue, Redux
 * Offline outbox pattern.
 */

export { offline, type OfflineOptions, type OfflineMethodPolicy } from "./offline.js";
export { InMemoryOfflineStore, type OfflineStore, type QueuedRequest } from "./store.js";
