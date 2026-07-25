/**
 * `@agentick/mcp/testing` — MCP test surface.
 *
 * Ships the executable conformance suite {@link runMcpConformance}. Per
 * the Meszaros taxonomy the package uses elsewhere, this is not a double
 * — it is a parameterized SUITE that drives REAL harnesses (a real
 * {@link McpServerHarness} ↔ a real {@link McpClientHarness} over the
 * real in-memory transport) plus a gated real-peer path. Only the
 * "model" is scripted, via direct verb calls.
 *
 * @see ./conformance.ts
 */

export { runMcpConformance, type McpConformanceOptions } from "./conformance.js";
