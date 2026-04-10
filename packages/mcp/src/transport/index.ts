/**
 * Transport re-exports from the MCP SDK.
 *
 * We don't wrap these — the SDK's transports are the protocol layer.
 * Consumers can also import directly from @modelcontextprotocol/sdk if they prefer.
 */

// In-process transport — zero overhead, linked pair for client ↔ server
export { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// The SDK Transport interface (for typing custom transports)
export type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
