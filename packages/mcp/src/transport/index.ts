/**
 * Transport exports.
 *
 * InMemoryTransport is our own implementation with deferred delivery
 * semantics (queueMicrotask), fixing a race condition in the SDK's version
 * where synchronous delivery causes "unknown message ID" errors.
 *
 * See: transport/in-memory.ts for details.
 */

export { InMemoryTransport } from "./in-memory.js";

// The SDK Transport interface (for typing custom transports)
export type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
