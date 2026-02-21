/**
 * Local Sandbox Provider
 *
 * Factory function that creates a SandboxProvider backed by OS-level sandboxing.
 */

import { randomBytes } from "node:crypto";
import type {
  SandboxProvider,
  SandboxHandle,
  SandboxCreateOptions,
  SandboxSnapshot,
  NetworkRule,
} from "@agentick/sandbox";
import { detectCapabilities, selectStrategy } from "./platform/detect.js";
import type { SandboxStrategy } from "./platform/types.js";
import { selectExecutor } from "./executor/select.js";
import type { ResolvedPermissions } from "./executor/types.js";
import { createWorkspace, destroyWorkspace, resolveMounts } from "./workspace.js";
import { filterEnv } from "./paths.js";
import { ResourceEnforcer } from "./resources.js";
import { CgroupManager } from "./linux/cgroup.js";
import { LocalSandbox } from "./local-sandbox.js";
import { NetworkProxyServer } from "./network/proxy.js";
import type { ProxyServerConfig } from "./network/proxy.js";

export interface LocalProviderConfig {
  /** Sandbox strategy. "auto" detects the best available. Default: "auto". */
  strategy?: SandboxStrategy | "auto";

  /** Network proxy configuration. */
  network?: ProxyServerConfig;

  /** Base directory for temp workspaces. Default: os.tmpdir(). */
  tmpBase?: string;

  /** Whether to clean up auto-created workspaces on destroy. Default: true. */
  cleanupWorkspace?: boolean;
}

/**
 * Create a local sandbox provider.
 *
 * @example
 * ```typescript
 * import { localProvider } from "@agentick/sandbox-local";
 *
 * const provider = localProvider();
 * const sandbox = await provider.create({ workspace: true });
 * const result = await sandbox.exec("echo hello");
 * await sandbox.destroy();
 * ```
 */
export function localProvider(config?: LocalProviderConfig): SandboxProvider {
  const cleanupDefault = config?.cleanupWorkspace ?? true;

  return {
    name: "local",

    async create(options: SandboxCreateOptions): Promise<SandboxHandle> {
      const caps = await detectCapabilities();
      const strategy = selectStrategy(caps, config?.strategy);

      // Workspace
      const workspace = await createWorkspace(options.workspace, config?.tmpBase);
      const mounts = await resolveMounts(options.mounts);

      // Permissions
      const permissions = resolvePermissions(
        options.permissions ?? {},
        workspace.path,
        mounts.map((m) => ({ path: m.hostPath, mode: m.mode })),
      );

      // CgroupManager (Linux only)
      let cgroup: CgroupManager | undefined;
      if (caps.hasCgroupsV2 && options.limits) {
        const id = randomBytes(4).toString("hex");
        cgroup = new CgroupManager(id);
        await cgroup.create(options.limits);
      }

      // Executor
      const executor = selectExecutor(strategy, cgroup);

      // Environment
      const baseEnv: Record<string, string> = {
        HOME: workspace.path,
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        TERM: "dumb",
      };

      if (options.permissions?.inheritEnv) {
        Object.assign(baseEnv, filterEnv(process.env as Record<string, string>));
      }

      if (options.env) {
        Object.assign(baseEnv, options.env);
      }

      // Network proxy
      let proxy: NetworkProxyServer | undefined;
      const netRules = Array.isArray(options.permissions?.net)
        ? (options.permissions!.net as NetworkRule[])
        : undefined;

      if (netRules && netRules.length > 0) {
        proxy = new NetworkProxyServer(netRules, config?.network);
        await proxy.start();

        // Inject proxy env vars
        baseEnv.HTTP_PROXY = proxy.proxyUrl;
        baseEnv.http_proxy = proxy.proxyUrl;
        baseEnv.HTTPS_PROXY = proxy.proxyUrl;
        baseEnv.https_proxy = proxy.proxyUrl;
      }

      // Resource enforcement
      const resources = new ResourceEnforcer(workspace.path, options.limits ?? {});
      await resources.start();

      const sandboxId = randomBytes(8).toString("hex");

      return new LocalSandbox({
        id: sandboxId,
        workspacePath: workspace.path,
        executor,
        env: baseEnv,
        mounts,
        permissions,
        resources,
        proxy,
        cleanupWorkspace: cleanupDefault,
        destroyWorkspace: () =>
          destroyWorkspace(workspace.path, workspace.autoCreated && cleanupDefault),
      });
    },

    async restore(snapshot: SandboxSnapshot): Promise<SandboxHandle> {
      const caps = await detectCapabilities();
      const strategy = selectStrategy(caps, config?.strategy);
      const executor = selectExecutor(strategy);

      const resources = new ResourceEnforcer(snapshot.workspacePath, {});
      await resources.start();

      return new LocalSandbox({
        id: snapshot.id,
        workspacePath: snapshot.workspacePath,
        executor,
        env: {
          HOME: snapshot.workspacePath,
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          TERM: "dumb",
        },
        mounts: [],
        permissions: {
          readPaths: [snapshot.workspacePath],
          writePaths: [snapshot.workspacePath],
          network: false,
          childProcess: true,
        },
        resources,
        cleanupWorkspace: false,
        destroyWorkspace: async () => {},
      });
    },
  };
}

function resolvePermissions(
  perms: NonNullable<SandboxCreateOptions["permissions"]>,
  workspacePath: string,
  mounts: { path: string; mode: "ro" | "rw" }[],
): ResolvedPermissions {
  const readPaths = [workspacePath];
  const writePaths = [workspacePath];

  for (const mount of mounts) {
    readPaths.push(mount.path);
    if (mount.mode === "rw") {
      writePaths.push(mount.path);
    }
  }

  return {
    readPaths,
    writePaths,
    network: perms.net ?? false,
    childProcess: perms.childProcess ?? true,
  };
}
