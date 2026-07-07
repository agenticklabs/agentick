/**
 * `@agentick/sandbox-lambda-next/agent` — the in-VM sandbox-agent bundle
 * (ADR 60).
 *
 * The far-side server baked into the microVM image. Importing this subpath
 * gives an adopter (or an image build) the `startSandboxAgent` entry, the
 * egress proxy, and the exec/fs primitives — all runnable inside the VM
 * against the local workspace filesystem. The near-side provider does NOT
 * import this bundle; it talks to the agent over the endpoint wire.
 *
 * @see docs/proposals/v2/blueprint/60-remote-microvm-sandbox.md
 */

export { startSandboxAgent } from "./server.js";
export type { SandboxAgent, StartSandboxAgentOptions } from "./server.js";
export { AgentEgressProxy, type EgressProxyConfig } from "./egress-proxy.js";
export {
  runExec,
  type ExecController,
  type ExecRunOptions,
  type ExecRunResult,
} from "./exec-runner.js";
export { agentEditFile, agentReadFile, agentWriteFile, resolveWorkspacePath } from "./fs-ops.js";
