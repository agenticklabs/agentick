/**
 * `localProvider` — the reference {@link SandboxProvider} (ADR 59).
 *
 * `create()` detects the host's isolation capability and selects a jail
 * strategy (darwin→seatbelt, linux→bwrap/unshare, else→honest passthrough),
 * allocates a workspace, resolves create-time mounts, starts a 127.0.0.1
 * egress proxy when `allow.network` is a rule list (injecting `HTTP(S)_PROXY`),
 * wires a Linux cgroup for `memoryMb`/`cpuPercent`, and returns a
 * {@link LocalSandbox} handle whose `exec` runs THROUGH the jail. The handle
 * surfaces the effective tier on `isolation` (never a false claim). The
 * harness (not the provider) runs `setup` and enforces the `mountAllow`
 * ceiling — the provider just does the work.
 *
 * `restore` is intentionally absent: no local checkpoint exists, and the
 * bridge only ever calls `create` (TODO(#223) — hibernate/restore deferred
 * to a remote/CRIU-style provider, per ADR 59).
 *
 * @see docs/proposals/v2/blueprint/59-sandbox-providers.md
 */

import { randomBytes } from "node:crypto";
import type {
  NetworkRule,
  SandboxCreateOptions,
  SandboxHandle,
  SandboxProvider,
} from "@agentick/sandbox";
import { selectExecutor } from "./executor/select.js";
import { CgroupManager } from "./linux/cgroup.js";
import { LocalSandbox } from "./local-sandbox.js";
import { detectCapabilities, selectStrategy } from "./platform/detect.js";
import type { SandboxStrategy } from "./platform/types.js";
import { NetworkProxyServer, type ProxyServerConfig } from "./proxy.js";
import { createWorkspace, destroyWorkspace, resolveMounts } from "./workspace.js";

export interface LocalProviderConfig {
  /**
   * Isolation strategy. `"auto"` (default) picks the strongest jail the host
   * supports. An explicit strategy the host cannot honor THROWS at `create`
   * (never silently downgrades to passthrough — ADR 59).
   */
  readonly strategy?: SandboxStrategy | "auto";
  /** Egress proxy configuration (port binding, audit hooks). */
  readonly network?: ProxyServerConfig;
  /** Base directory for auto-allocated temp workspaces. Default: os.tmpdir(). */
  readonly tmpBase?: string;
  /** Clean up auto-created workspaces on destroy. Default: true. */
  readonly cleanupWorkspace?: boolean;
}

/**
 * Create a local sandbox provider.
 *
 * @example
 * ```ts
 * import { localProvider } from "@agentick/sandbox-local";
 *
 * const provider = localProvider();
 * const sandbox = await provider.create({ workspace: true });
 * const { stdout } = await sandbox.exec("echo hello");
 * await sandbox.destroy();
 * ```
 */
export function localProvider(config?: LocalProviderConfig): SandboxProvider {
  const cleanup = config?.cleanupWorkspace ?? true;

  return {
    name: "local",

    async create(options: SandboxCreateOptions): Promise<SandboxHandle> {
      // Detect host isolation capability + select the jail. An explicit
      // unsupported override throws HERE (before allocating resources).
      const caps = await detectCapabilities();
      const strategy = selectStrategy(caps, config?.strategy);

      const workspace = await createWorkspace(options.workspace, config?.tmpBase);
      const mounts = await resolveMounts(options.mounts);

      const env: Record<string, string> = {
        HOME: workspace.path,
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        TERM: "dumb",
        ...(options.env ?? {}),
      };

      // Egress proxy — engaged only when a rule list is supplied. `true`
      // (allow-all) and `false`/absent (deny-all — enforced at the jail
      // level for seatbelt/bwrap, see below) don't start a proxy.
      let proxy: NetworkProxyServer | undefined;
      const network = options.allow?.network ?? false;
      if (Array.isArray(network) && network.length > 0) {
        proxy = new NetworkProxyServer(network as readonly NetworkRule[], config?.network);
        await proxy.start();
        env.HTTP_PROXY = proxy.proxyUrl;
        env.http_proxy = proxy.proxyUrl;
        env.HTTPS_PROXY = proxy.proxyUrl;
        env.https_proxy = proxy.proxyUrl;
      }

      // Linux cgroup for memoryMb/cpuPercent (best-effort; no-op where
      // cgroups v2 isn't writable). diskMb + wallClockSec are enforced by
      // the handle (disk poller + per-exec timeout), not the cgroup.
      // TODO(#240): macOS has no cgroups — memoryMb/cpuPercent are documented
      // unsupported (README). A future best-effort path could prepend
      // `ulimit -v/-t` inside the seatbelt bash invocation; deferred because
      // macOS RLIMIT_AS enforcement is unreliable and would risk a false claim.
      let cgroup: CgroupManager | undefined;
      const limits = options.limits;
      if (
        caps.hasCgroupsV2 &&
        limits &&
        (limits.memoryMb !== undefined || limits.cpuPercent !== undefined)
      ) {
        cgroup = new CgroupManager(randomBytes(4).toString("hex"));
        await cgroup.create(limits);
      }

      const executor = selectExecutor(strategy, cgroup);

      const init: ConstructorParameters<typeof LocalSandbox>[0] = {
        id: randomBytes(8).toString("hex"),
        workspacePath: workspace.path,
        env,
        mounts,
        executor,
        isolation: strategy,
        network,
        destroyWorkspace: () => destroyWorkspace(workspace.path, workspace.autoCreated && cleanup),
        ...(proxy ? { proxy } : {}),
        ...(cgroup ? { cgroup } : {}),
        ...(limits?.diskMb !== undefined ? { diskMb: limits.diskMb } : {}),
        ...(limits?.wallClockSec !== undefined
          ? { defaultTimeoutMs: limits.wallClockSec * 1000 }
          : {}),
      };
      return new LocalSandbox(init);
    },
  };
}
