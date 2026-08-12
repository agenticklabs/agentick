/**
 * `@agentick/sandbox-local` — the local reference {@link SandboxProvider}.
 *
 * Spawns commands THROUGH a platform jail (seatbelt / bwrap / unshare, or an
 * honest passthrough where none exists), path-confines the file API, writes
 * atomically, mounts host dirs dynamically, and routes egress through a
 * 127.0.0.1 proxy. Deps the base package `@agentick/sandbox` and
 * implements its `SandboxProvider` — mirroring
 * `@agentick/model-openai → @agentick/model` (ADR 59). The base re-exports the
 * spec wire types, the
 * `applyEdits` transform, and the `matchRequest` matcher, so this
 * provider has ONE import source.
 *
 * @see docs/proposals/v2/blueprint/59-sandbox-providers.md
 */

export { defineSandbox, type LocalSandboxOptions } from "./define-sandbox.js";
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

// ── OS-isolation jail (ADR 59, #240) ──
// The effective isolation tier a handle runs under is `LocalSandbox.isolation`.
// These helpers let an operator probe host capability BEFORE creating a
// sandbox (e.g. to fail closed when no jail is available).
export { detectCapabilities, selectStrategy, resetCapabilitiesCache } from "./platform/detect.js";
export type { PlatformCapabilities, SandboxStrategy } from "./platform/types.js";
export { CgroupManager } from "./linux/cgroup.js";
export { DiskMonitor } from "./resources.js";
export { selectExecutor } from "./executor/select.js";
export type { CommandExecutor, SpawnOptions } from "./executor/types.js";
