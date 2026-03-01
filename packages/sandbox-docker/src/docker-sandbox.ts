/**
 * DockerSandbox — implements the Sandbox contract using Docker containers.
 *
 * One container per sandbox. Commands run via `docker exec`.
 * File I/O via exec (cat for reads, base64 piping for writes).
 * No host-level filesystem access — keeps the isolation boundary clean.
 */

import { posix } from "node:path";
import type { SandboxHandle, ExecOptions, ExecResult, Mount } from "@agentick/sandbox";
import type { Edit, EditResult } from "@agentick/sandbox";
import { applyEdits, SandboxAccessError } from "@agentick/sandbox";
import type { DockerAPI } from "./docker-api.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DockerSandboxInit {
  id: string;
  containerId: string;
  workspacePath: string;
  volumeName?: string;
  mounts: MountInfo[];
  api: DockerAPI;
  cleanupContainer: boolean;
  cleanupVolume: boolean;
}

export interface MountInfo {
  hostPath: string;
  containerPath: string;
  mode: "ro" | "rw";
}

// ── Implementation ───────────────────────────────────────────────────────────

export class DockerSandbox implements SandboxHandle {
  readonly id: string;
  readonly workspacePath: string;

  private readonly containerId: string;
  private readonly volumeName?: string;
  private readonly mounts: MountInfo[];
  private readonly api: DockerAPI;
  private readonly cleanupContainer: boolean;
  private readonly cleanupVolume: boolean;
  private destroyed = false;

  constructor(init: DockerSandboxInit) {
    this.id = init.id;
    this.containerId = init.containerId;
    this.workspacePath = init.workspacePath;
    this.volumeName = init.volumeName;
    this.mounts = [...init.mounts];
    this.api = init.api;
    this.cleanupContainer = init.cleanupContainer;
    this.cleanupVolume = init.cleanupVolume;
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    this.assertAlive();

    const cwd = options?.cwd
      ? resolveContainerPath(options.cwd, this.workspacePath, "read", this.mounts)
      : this.workspacePath;

    const env = options?.env ? Object.entries(options.env).map(([k, v]) => `${k}=${v}`) : undefined;

    const execId = await this.api.execCreate(this.containerId, {
      Cmd: ["sh", "-c", command],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: cwd,
      Env: env,
    });

    let timedOut = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (options?.timeout) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeout);
    }

    const streamResult = await this.api.execStart(execId, {
      onStdout: options?.onOutput
        ? (data) => options.onOutput!({ stream: "stdout", data })
        : undefined,
      onStderr: options?.onOutput
        ? (data) => options.onOutput!({ stream: "stderr", data })
        : undefined,
      signal: controller.signal,
    });

    if (timer) clearTimeout(timer);

    let exitCode: number;
    if (timedOut) {
      exitCode = 124;
    } else {
      const inspection = await this.api.execInspect(execId);
      exitCode = inspection.ExitCode;
    }

    return {
      stdout: streamResult.stdout,
      stderr: streamResult.stderr + (timedOut ? "\n[sandbox: command timed out]" : ""),
      exitCode,
    };
  }

  async readFile(path: string): Promise<string> {
    this.assertAlive();
    const resolved = resolveContainerPath(path, this.workspacePath, "read", this.mounts);

    const result = await this.execInContainer(["cat", resolved]);

    if (result.exitCode !== 0) {
      const msg = result.stderr.trim();
      if (msg.includes("No such file")) {
        throw Object.assign(new Error(`ENOENT: no such file: ${path}`), {
          code: "ENOENT",
        });
      }
      throw new Error(`readFile failed: ${msg}`);
    }

    return result.stdout;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.assertAlive();
    const resolved = resolveContainerPath(path, this.workspacePath, "write", this.mounts);

    const dir = posix.dirname(resolved);
    const b64 = Buffer.from(content, "utf-8").toString("base64");

    // base64 output is [A-Za-z0-9+/=] — safe in single quotes.
    // Path needs shell quoting for special characters.
    const result = await this.execInContainer([
      "sh",
      "-c",
      `mkdir -p ${shellQuote(dir)} && printf '%s' '${b64}' | base64 -d > ${shellQuote(resolved)}`,
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`writeFile failed: ${result.stderr.trim()}`);
    }
  }

  async editFile(path: string, edits: Edit[]): Promise<EditResult> {
    this.assertAlive();
    resolveContainerPath(path, this.workspacePath, "write", this.mounts);

    const source = await this.readFile(path);
    const result = applyEdits(source, edits);
    if (result.applied === 0) return result;

    await this.writeFile(path, result.content);
    return result;
  }

  async addMount(mount: Mount): Promise<void> {
    this.assertAlive();
    const containerPath = mount.sandbox;
    const mode = mount.mode ?? "rw";

    // Can't hot-add bind mounts to a running container.
    // Track in the allow list so path validation passes.
    const existingIdx = this.mounts.findIndex((m) => m.containerPath === containerPath);

    if (existingIdx !== -1) {
      const existing = this.mounts[existingIdx]!;
      if (existing.mode === "rw" || mode === existing.mode) return;
      this.mounts[existingIdx] = {
        hostPath: mount.host,
        containerPath,
        mode,
      };
      return;
    }

    this.mounts.push({ hostPath: mount.host, containerPath, mode });
  }

  removeMount(hostPath: string): void {
    this.assertAlive();
    const idx = this.mounts.findIndex((m) => m.hostPath === hostPath);
    if (idx !== -1) this.mounts.splice(idx, 1);
  }

  listMounts(): Mount[] {
    return this.mounts.map((m) => ({
      host: m.hostPath,
      sandbox: m.containerPath,
      mode: m.mode,
    }));
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.cleanupContainer) {
      try {
        await this.api.removeContainer(this.containerId, {
          force: true,
          v: true,
        });
      } catch {
        // Container may already be gone
      }
    }

    if (this.cleanupVolume && this.volumeName) {
      try {
        await this.api.removeVolume(this.volumeName);
      } catch {
        // Volume may already be gone
      }
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async execInContainer(cmd: string[]): Promise<ExecResult> {
    const execId = await this.api.execCreate(this.containerId, {
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: this.workspacePath,
    });

    const result = await this.api.execStart(execId);
    const inspection = await this.api.execInspect(execId);

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: inspection.ExitCode,
    };
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error(`Sandbox ${this.id} has been destroyed`);
    }
  }
}

// ── Pure Functions ───────────────────────────────────────────────────────────

/**
 * Resolve and validate a path within the container filesystem.
 *
 * All paths are POSIX (containers run Linux). String-based validation
 * only — no symlink resolution (would require exec inside container).
 * The container itself provides the isolation boundary; this is defense-in-depth.
 */
export function resolveContainerPath(
  inputPath: string,
  workspacePath: string,
  mode: "read" | "write",
  mounts: MountInfo[] = [],
): string {
  if (inputPath.includes("\0")) {
    throw new Error("Path contains null bytes");
  }

  const absolute = posix.isAbsolute(inputPath) ? inputPath : posix.join(workspacePath, inputPath);
  const resolved = posix.normalize(absolute);

  if (resolved === workspacePath || resolved.startsWith(workspacePath + "/")) {
    return resolved;
  }

  for (const mount of mounts) {
    if (resolved === mount.containerPath || resolved.startsWith(mount.containerPath + "/")) {
      if (mode === "write" && mount.mode === "ro") {
        throw new Error(
          `Write denied: ${inputPath} resolves to read-only mount ${mount.containerPath}`,
        );
      }
      return resolved;
    }
  }

  throw new SandboxAccessError(inputPath, resolved, mode);
}

/** Quote a string for safe use in sh. */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
