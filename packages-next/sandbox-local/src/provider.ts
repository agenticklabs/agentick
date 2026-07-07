/**
 * `localProvider` — the reference {@link SandboxProvider} (ADR 59).
 *
 * `create()` allocates a workspace, resolves create-time mounts, starts a
 * 127.0.0.1 egress proxy when `allow.network` is a rule list (injecting
 * `HTTP(S)_PROXY`), and returns a {@link LocalSandbox} handle. The harness
 * (not the provider) runs `setup` and enforces the `mountAllow` ceiling —
 * the provider just does the work.
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
} from "@agentick/spec-next";
import { LocalSandbox } from "./local-sandbox.js";
import { NetworkProxyServer, type ProxyServerConfig } from "./proxy.js";
import { createWorkspace, destroyWorkspace, resolveMounts } from "./workspace.js";

export interface LocalProviderConfig {
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
 * import { localProvider } from "@agentick/sandbox-local-next";
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
      const workspace = await createWorkspace(options.workspace, config?.tmpBase);
      const mounts = await resolveMounts(options.mounts);

      const env: Record<string, string> = {
        HOME: workspace.path,
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        TERM: "dumb",
        ...(options.env ?? {}),
      };

      // Egress proxy — engaged only when a rule list is supplied. `true`
      // (allow-all) and `false`/absent (deny-all, but unenforced at the
      // process level here) don't start a proxy.
      let proxy: NetworkProxyServer | undefined;
      const network = options.allow?.network;
      if (Array.isArray(network) && network.length > 0) {
        proxy = new NetworkProxyServer(network as readonly NetworkRule[], config?.network);
        await proxy.start();
        env.HTTP_PROXY = proxy.proxyUrl;
        env.http_proxy = proxy.proxyUrl;
        env.HTTPS_PROXY = proxy.proxyUrl;
        env.https_proxy = proxy.proxyUrl;
      }

      const init: ConstructorParameters<typeof LocalSandbox>[0] = {
        id: randomBytes(8).toString("hex"),
        workspacePath: workspace.path,
        env,
        mounts,
        destroyWorkspace: () => destroyWorkspace(workspace.path, workspace.autoCreated && cleanup),
        ...(proxy ? { proxy } : {}),
        ...(options.limits?.wallClockSec !== undefined
          ? { defaultTimeoutMs: options.limits.wallClockSec * 1000 }
          : {}),
      };
      return new LocalSandbox(init);
    },
  };
}
