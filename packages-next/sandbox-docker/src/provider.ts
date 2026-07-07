/**
 * `dockerProvider` — a {@link SandboxProvider} backed by Docker containers
 * (ADR 59, Wave 2b).
 *
 * `create()` allocates a workspace (docker volume for `true`/auto, host
 * bind for an explicit path), binds create-time `mounts` via `-v`, resolves
 * the coarse network tier to a `NetworkMode`, translates resource limits to
 * `HostConfig`, then starts a `sleep infinity` container and returns a
 * {@link DockerSandbox}. The harness (not the provider) runs `setup` and
 * enforces the `mountAllow` ceiling.
 *
 * `restore` is intentionally absent: docker has no true checkpoint, and the
 * bridge only ever calls `create` (TODO(#223) — hibernate/restore deferred
 * to a remote/CRIU-style provider, per ADR 59).
 *
 * ## Network tier — coarse, honest (flagged for scrutiny)
 * Docker enforces egress via `NetworkMode` (ADR 59's three-layer split:
 * the 127.0.0.1 proxy is local-only; docker uses the container network):
 *   - `allow.network === true`  → `NetworkMode: "bridge"` (egress allowed)
 *   - `false` / undefined       → the configured `networkMode` (default
 *                                 `"none"` — no network at all, deny-all)
 *   - `NetworkRule[]`           → **`SandboxUnsupportedError`**. Per-domain
 *     egress filtering is NOT expressible via `NetworkMode`; it needs an
 *     egress proxy (local's mechanism) or an in-container firewall
 *     (a future provider). Coarse-mapping a default-deny rule list to
 *     `bridge` would allow-all (violating the denies) and to `none` would
 *     deny-all (violating the allows) — both silent lies. v1 only ever did
 *     the coarse boolean tier; this makes the ceiling explicit.
 *
 * @see docs/proposals/v2/blueprint/59-sandbox-providers.md
 */

import { randomBytes } from "node:crypto";
import type {
  SandboxCreateOptions,
  SandboxHandle,
  SandboxPermissions,
  SandboxProvider,
} from "@agentick/sandbox-next";
import { SandboxUnsupportedError } from "@agentick/sandbox-next";
import type { ContainerConfig } from "./docker-api.js";
import { DockerAPI } from "./docker-api.js";
import { DockerSandbox, type MountInfo } from "./docker-sandbox.js";

export interface DockerProviderConfig {
  /** Docker image. Default: `"node:22-slim"`. */
  readonly image?: string;
  /** Docker socket path. Default: `"/var/run/docker.sock"`. */
  readonly socketPath?: string;
  /** Workspace path inside the container. Default: `"/workspace"`. */
  readonly workspacePath?: string;
  /** `NetworkMode` when network is not `true`. Default: `"none"`. */
  readonly networkMode?: string;
  /** Remove containers on destroy. Default: `true`. */
  readonly cleanupContainers?: boolean;
  /** Remove volumes on destroy. Default: `true`. */
  readonly cleanupVolumes?: boolean;
  /** Labels applied to containers + volumes. */
  readonly labels?: Record<string, string>;
}

/**
 * Create a docker sandbox provider.
 *
 * @example
 * ```ts
 * import { dockerProvider } from "@agentick/sandbox-docker-next";
 *
 * const provider = dockerProvider({ image: "node:22-slim" });
 * const sandbox = await provider.create({ workspace: true });
 * const { stdout } = await sandbox.exec("node -e 'console.log(1+1)'"); // "2"
 * await sandbox.destroy();
 * ```
 */
export function dockerProvider(config?: DockerProviderConfig): SandboxProvider {
  const image = config?.image ?? "node:22-slim";
  const socketPath = config?.socketPath ?? "/var/run/docker.sock";
  const containerWorkspace = config?.workspacePath ?? "/workspace";
  const networkMode = config?.networkMode ?? "none";
  const cleanupContainers = config?.cleanupContainers ?? true;
  const cleanupVolumes = config?.cleanupVolumes ?? true;
  const labels = { "agentick.sandbox": "true", ...config?.labels };

  const api = new DockerAPI(socketPath);

  return {
    name: "docker",

    async create(options: SandboxCreateOptions): Promise<SandboxHandle> {
      // Resolve the network tier FIRST — a NetworkRule[] throws
      // SandboxUnsupportedError, and we want it to fail fast before
      // allocating a volume or container (no leaked resources).
      const resolvedNetwork = resolveNetworkMode(options.allow?.network, networkMode);

      const sandboxId = randomBytes(8).toString("hex");

      // Workspace: docker volume (auto) or host bind mount (explicit path).
      let volumeName: string | undefined;
      const binds: string[] = [];

      if (options.workspace === true || options.workspace === undefined) {
        const vol = await api.createVolume(`agentick-sandbox-${sandboxId}`);
        volumeName = vol.Name;
        binds.push(`${volumeName}:${containerWorkspace}`);
      } else {
        binds.push(`${options.workspace}:${containerWorkspace}`);
      }

      // Create-time mounts → bind mounts (the only mount tier docker
      // supports; runtime add/remove throw SandboxUnsupportedError).
      const mountInfos: MountInfo[] = [];
      for (const mount of options.mounts ?? []) {
        const readOnly = mount.readOnly ?? false;
        binds.push(`${mount.hostPath}:${mount.sandboxPath}${readOnly ? ":ro" : ""}`);
        mountInfos.push({
          hostPath: mount.hostPath,
          containerPath: mount.sandboxPath,
          readOnly,
        });
      }

      // Environment.
      const env: string[] = [
        `HOME=${containerWorkspace}`,
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "TERM=dumb",
        ...Object.entries(options.env ?? {}).map(([k, v]) => `${k}=${v}`),
      ];

      // Resource limits → HostConfig. Disk quota (diskMb) needs storage-driver
      // support and is intentionally not mapped here.
      const hostConfig: NonNullable<ContainerConfig["HostConfig"]> = {
        Binds: binds,
        NetworkMode: resolvedNetwork,
        ...(options.limits?.memoryMb ? { Memory: options.limits.memoryMb * 1024 * 1024 } : {}),
        ...(options.limits?.cpuPercent
          ? { NanoCpus: Math.round((options.limits.cpuPercent / 100) * 1e9) }
          : {}),
      };

      const containerId = await api.createContainer({
        Image: image,
        Cmd: ["sleep", "infinity"],
        Env: env,
        WorkingDir: containerWorkspace,
        Labels: labels,
        HostConfig: hostConfig,
      });

      await api.startContainer(containerId);

      return new DockerSandbox({
        id: sandboxId,
        containerId,
        workspacePath: containerWorkspace,
        ...(volumeName !== undefined ? { volumeName } : {}),
        mounts: mountInfos,
        api,
        cleanupContainer: cleanupContainers,
        cleanupVolume: cleanupVolumes,
        ...(options.limits?.wallClockSec !== undefined
          ? { defaultTimeoutMs: options.limits.wallClockSec * 1000 }
          : {}),
      });
    },
  };
}

/**
 * Map the ADR 59 network policy onto a docker `NetworkMode`. The docker
 * tier is coarse: boolean only. A per-domain rule list is unsupported here
 * (see the module doc for why coarse-mapping it would be a silent lie).
 */
function resolveNetworkMode(network: SandboxPermissions["network"], defaultMode: string): string {
  if (network === true) return "bridge";
  if (network === undefined || network === false) return defaultMode;
  // NetworkRule[] — not expressible via NetworkMode.
  throw new SandboxUnsupportedError({
    capability:
      "network:rules — the docker tier enforces coarse NetworkMode (allow-all / deny-all) only; " +
      "per-domain egress filtering needs an egress proxy (sandbox-local-next) or firewall sidecar",
  });
}
