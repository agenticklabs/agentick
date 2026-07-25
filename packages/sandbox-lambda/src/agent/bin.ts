#!/usr/bin/env node
/**
 * Executable entry for the in-VM sandbox-agent (ADR 60).
 *
 * The microVM image's Dockerfile `CMD` runs this. It reads its configuration
 * from the environment (`run-microvm` delivers per-session env), starts the
 * agent, and stays alive for the microVM's lifetime:
 *   - `SANDBOX_WORKSPACE`  — workspace root (default: cwd)
 *   - `SANDBOX_AGENT_PORT` — bind port (default: 8080)
 *   - `SANDBOX_AGENT_HOST` — bind host (default: 0.0.0.0)
 *   - `SANDBOX_NET_RULES`  — JSON `NetworkRule[]` for domain-level egress
 *
 * @see docs/proposals/v2/blueprint/60-remote-microvm-sandbox.md
 */

import type { NetworkRule } from "@agentick/sandbox";
import { startSandboxAgent } from "./server.js";

async function main(): Promise<void> {
  let networkRules: readonly NetworkRule[] | undefined;
  if (process.env.SANDBOX_NET_RULES) {
    try {
      networkRules = JSON.parse(process.env.SANDBOX_NET_RULES) as NetworkRule[];
    } catch {
      throw new Error("SANDBOX_NET_RULES is not valid JSON NetworkRule[]");
    }
  }

  const agent = await startSandboxAgent({
    ...(process.env.SANDBOX_WORKSPACE ? { workspace: process.env.SANDBOX_WORKSPACE } : {}),
    port: process.env.SANDBOX_AGENT_PORT
      ? Number.parseInt(process.env.SANDBOX_AGENT_PORT, 10)
      : 8080,
    ...(process.env.SANDBOX_AGENT_HOST ? { host: process.env.SANDBOX_AGENT_HOST } : {}),
    ...(networkRules ? { networkRules } : {}),
  });

  // eslint-disable-next-line no-console
  console.log(`[sandbox-agent] listening on :${agent.port} (workspace=${agent.workspacePath})`);

  const shutdown = (): void => {
    void agent.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main();
