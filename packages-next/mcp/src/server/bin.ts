#!/usr/bin/env node
/**
 * `agentick-mcp-server` — Mode A standalone process entry point.
 *
 * Synthesizes a minimal gateway shell (substrate: in-memory
 * journal/bus/inbox; cluster: defineLocalCluster; no app-spawning),
 * mounts a configured `McpServerHarness`, attaches transports, runs
 * until SIGINT / SIGTERM. The harness is the same one Mode B
 * (gateway-extension) mounts; only the surrounding shell differs.
 *
 * **Placeholder (#171b).** Real implementation lands in #171c when
 * stdio transport + projection are ready. For now this just refuses
 * to start with a helpful error pointing at the rollout plan.
 *
 * @see docs/proposals/v2/blueprint/40-mcp-server-harness.md §10
 */

// eslint-disable-next-line no-console
console.error(
  [
    "agentick-mcp-server: standalone Mode A CLI is a placeholder.",
    "Lands with #171c (stdio transport + tools projection MVP).",
    "Track ADR 40 rollout: docs/proposals/v2/blueprint/40-mcp-server-harness.md",
  ].join("\n"),
);
process.exit(78); // EX_CONFIG — config-not-yet-implemented sentinel
