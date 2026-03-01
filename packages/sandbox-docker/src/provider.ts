/**
 * Docker Sandbox Provider
 *
 * Factory function that creates a SandboxProvider backed by Docker containers.
 * One container per sandbox, kept alive with `sleep infinity`, commands via exec.
 */

import { randomBytes } from "node:crypto";
import type { SandboxProvider, SandboxHandle, SandboxCreateOptions } from "@agentick/sandbox";
import { DockerAPI } from "./docker-api.js";
import { DockerSandbox } from "./docker-sandbox.js";
import type { MountInfo } from "./docker-sandbox.js";

export interface DockerProviderConfig {
  /** Docker image. Default: "node:22-slim". */
  image?: string;

  /** Docker socket path. Default: "/var/run/docker.sock". */
  socketPath?: string;

  /** Workspace path inside the container. Default: "/workspace". */
  workspacePath?: string;

  /** Docker network mode when net is false. Default: "none". */
  networkMode?: string;

  /** Remove containers on destroy. Default: true. */
  cleanupContainers?: boolean;

  /** Remove volumes on destroy. Default: true. */
  cleanupVolumes?: boolean;

  /** Labels to apply to containers and volumes. */
  labels?: Record<string, string>;
}

export function dockerProvider(config?: DockerProviderConfig): SandboxProvider {
  const image = config?.image ?? "node:22-slim";
  const socketPath = config?.socketPath ?? "/var/run/docker.sock";
  const containerWorkspace = config?.workspacePath ?? "/workspace";
  const networkMode = config?.networkMode ?? "none";
  const cleanupContainers = config?.cleanupContainers ?? true;
  const cleanupVolumes = config?.cleanupVolumes ?? true;
  const labels = {
    "agentick.sandbox": "true",
    ...config?.labels,
  };

  const api = new DockerAPI(socketPath);

  return {
    name: "docker",

    async create(options: SandboxCreateOptions): Promise<SandboxHandle> {
      const sandboxId = randomBytes(8).toString("hex");

      // Workspace: Docker volume (auto) or bind mount (explicit path)
      let volumeName: string | undefined;
      const binds: string[] = [];

      if (options.workspace === true || options.workspace === undefined) {
        const vol = await api.createVolume(`agentick-sandbox-${sandboxId}`);
        volumeName = vol.Name;
        binds.push(`${volumeName}:${containerWorkspace}`);
      } else {
        binds.push(`${options.workspace}:${containerWorkspace}`);
      }

      // User mounts → bind mounts
      const mountInfos: MountInfo[] = [];
      if (options.mounts) {
        for (const mount of options.mounts) {
          const mode = mount.mode ?? "rw";
          const bindSpec = `${mount.host}:${mount.sandbox}${mode === "ro" ? ":ro" : ""}`;
          binds.push(bindSpec);
          mountInfos.push({
            hostPath: mount.host,
            containerPath: mount.sandbox,
            mode,
          });
        }
      }

      // Environment
      const env: string[] = [
        `HOME=${containerWorkspace}`,
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "TERM=dumb",
      ];
      if (options.env) {
        for (const [k, v] of Object.entries(options.env)) {
          env.push(`${k}=${v}`);
        }
      }

      // Network: true → bridge, false/undefined → configured mode (default "none")
      const net = options.permissions?.net;
      const resolvedNetwork = net === true ? "bridge" : networkMode;

      // Resource limits
      const hostConfig: NonNullable<import("./docker-api.js").ContainerConfig["HostConfig"]> = {
        Binds: binds,
        NetworkMode: resolvedNetwork,
        ...(options.limits?.memory && { Memory: options.limits.memory }),
        ...(options.limits?.cpu && {
          NanoCpus: Math.round(options.limits.cpu * 1e9),
        }),
        ...(options.limits?.maxProcesses && {
          PidsLimit: options.limits.maxProcesses,
        }),
      };

      // Create + start container
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
        volumeName,
        mounts: mountInfos,
        api,
        cleanupContainer: cleanupContainers,
        cleanupVolume: cleanupVolumes,
      });
    },
  };
}
