/**
 * `@agentick/sandbox-local-next` — the local reference {@link SandboxProvider}.
 *
 * Spawns commands in a temp workspace, path-confines the file API, writes
 * atomically, mounts host dirs dynamically, and routes egress through a
 * 127.0.0.1 proxy. Depends on `spec-next` + the shared pure packages
 * (`sandbox-edit-next`, `sandbox-net-next`) only — never on the harness
 * package `@agentick/sandbox-next` (ADR 59).
 *
 * @see docs/proposals/v2/blueprint/59-sandbox-providers.md
 */

export { localProvider, type LocalProviderConfig } from "./provider.js";
export { LocalSandbox, type LocalSandboxInit } from "./local-sandbox.js";
export { NetworkProxyServer, type ProxyServerConfig } from "./proxy.js";
export {
  createWorkspace,
  destroyWorkspace,
  resolveMount,
  resolveMounts,
  type ResolvedMount,
} from "./workspace.js";
export { resolveSafePath, filterEnv, ENV_BLOCKLIST } from "./paths.js";
