/**
 * `DockerSandbox` — a {@link SandboxHandle} backed by one Docker container.
 *
 * One container per sandbox (kept alive with `sleep infinity`), commands
 * via `docker exec`. File I/O goes through exec too (`cat` for reads,
 * base64-piping for writes) — no host filesystem access, keeping the
 * isolation boundary at the container. `editFile` reads → the shared pure
 * `applyEdits` (crown jewel, re-exported from the base) → writes back.
 *
 * Capability tiers (honest, per ADR 59 — never fake):
 *   - **Runtime mounts** (`addMount`/`removeMount`/`listMounts`) throw
 *     `SandboxUnsupportedError`: docker cannot bind-mount a host dir onto
 *     a RUNNING container. Create-time `mounts` (via `-v`) work and are
 *     honored for path resolution. Unlike stat/readdir, `bash` cannot
 *     subsume a host-side privileged mount, so the methods exist to
 *     signal "unsupported" loudly rather than being silently absent.
 *   - **Exec abort/timeout** detaches the HTTP stream and reports
 *     `exitCode: 124`, `signaled: true`. The in-container process is
 *     reaped on `destroy()` — docker exposes no per-exec kill via the
 *     Engine API. This is a carried-forward v1 limitation, not new.
 *
 * @see docs/proposals/v2/blueprint/59-sandbox-providers.md
 */

import { posix } from "node:path";
import { applyEdits } from "@agentick/sandbox-next";
import type {
  SandboxEdit,
  SandboxEditResult,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxHandle,
  SandboxMount,
} from "@agentick/sandbox-next";
import {
  SandboxEscapeError,
  SandboxIoError,
  SandboxPermissionDeniedError,
  SandboxUnsupportedError,
} from "@agentick/sandbox-next";
import type { DockerAPI } from "./docker-api.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DockerSandboxInit {
  readonly id: string;
  readonly containerId: string;
  readonly workspacePath: string;
  readonly volumeName?: string;
  readonly mounts: MountInfo[];
  readonly api: DockerAPI;
  readonly cleanupContainer: boolean;
  readonly cleanupVolume: boolean;
  /** Default per-exec wall-clock ceiling (ms). Best-effort. */
  readonly defaultTimeoutMs?: number;
}

/** Create-time mount, resolved to container-internal coordinates. */
export interface MountInfo {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
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
  private readonly defaultTimeoutMs?: number;
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
    this.defaultTimeoutMs = init.defaultTimeoutMs;
  }

  async exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult> {
    this.assertAlive();
    const started = Date.now();

    const cwd = options?.cwd
      ? resolveContainerPath(options.cwd, this.workspacePath, "read", this.mounts)
      : this.workspacePath;

    const env = options?.env ? Object.entries(options.env).map(([k, v]) => `${k}=${v}`) : undefined;

    // stdin is delivered by piping decoded base64 into the command — the
    // Engine API's exec-stdin needs a hijacked bidirectional socket, which
    // this thin client doesn't open. `pipefail` isn't default in sh, so the
    // pipeline's exit code is the command's (base64 -d is upstream).
    const finalCommand =
      options?.stdin !== undefined
        ? `printf '%s' '${Buffer.from(options.stdin, "utf-8").toString("base64")}' | base64 -d | { ${command}\n; }`
        : command;

    const execId = await this.api.execCreate(this.containerId, {
      Cmd: ["sh", "-c", finalCommand],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: cwd,
      Env: env,
    });

    // Abort on timeout OR external signal — both detach the stream.
    const controller = new AbortController();
    let timedOut = false;
    let aborted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        aborted = true;
        controller.abort();
      }, timeoutMs);
      timer.unref();
    }

    const onExternalAbort = (): void => {
      aborted = true;
      controller.abort();
    };
    if (options?.signal) {
      if (options.signal.aborted) onExternalAbort();
      else options.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    let streamResult: { stdout: string; stderr: string };
    try {
      streamResult = await this.api.execStart(execId, {
        onStdout: options?.onOutput
          ? (chunk) => options.onOutput!({ stream: "stdout", chunk })
          : undefined,
        onStderr: options?.onOutput
          ? (chunk) => options.onOutput!({ stream: "stderr", chunk })
          : undefined,
        signal: controller.signal,
      });
    } finally {
      if (timer) clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onExternalAbort);
    }

    let exitCode: number;
    if (aborted) {
      exitCode = 124;
    } else {
      const inspection = await this.api.execInspect(execId);
      exitCode = inspection.ExitCode;
    }

    return {
      stdout: streamResult.stdout,
      stderr:
        streamResult.stderr +
        (timedOut
          ? "\n[sandbox: command timed out]"
          : aborted
            ? "\n[sandbox: command aborted]"
            : ""),
      exitCode,
      signaled: aborted,
      durationMs: Date.now() - started,
    };
  }

  async readFile(path: string): Promise<string> {
    this.assertAlive();
    const resolved = resolveContainerPath(path, this.workspacePath, "read", this.mounts);

    const result = await this.execInContainer(["cat", resolved]);
    if (result.exitCode !== 0) {
      throw new SandboxIoError({
        path,
        op: "read",
        reason: result.stderr.trim() || `cat exited ${result.exitCode}`,
      });
    }
    return result.stdout;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.assertAlive();
    const resolved = resolveContainerPath(path, this.workspacePath, "write", this.mounts);
    const dir = posix.dirname(resolved);
    const b64 = Buffer.from(content, "utf-8").toString("base64");

    // base64 output is [A-Za-z0-9+/=] — safe in single quotes; the path is
    // shell-quoted for special characters. Write atomically via a temp file
    // + `mv` inside the container (the temp+rename the ADR says the PROVIDER
    // owns), falling back is unnecessary — same-dir rename is atomic on the
    // container's own fs.
    const tmp = `${resolved}.write-${Date.now()}.tmp`;
    const result = await this.execInContainer([
      "sh",
      "-c",
      `mkdir -p ${shellQuote(dir)} && ` +
        `printf '%s' '${b64}' | base64 -d > ${shellQuote(tmp)} && ` +
        `mv -f ${shellQuote(tmp)} ${shellQuote(resolved)}`,
    ]);

    if (result.exitCode !== 0) {
      throw new SandboxIoError({
        path,
        op: "write",
        reason: result.stderr.trim() || `write exited ${result.exitCode}`,
      });
    }
  }

  async editFile(path: string, edits: readonly SandboxEdit[]): Promise<SandboxEditResult> {
    this.assertAlive();
    // Validate the path up front (also rejects out-of-bounds writes).
    resolveContainerPath(path, this.workspacePath, "write", this.mounts);

    let source: string;
    try {
      source = await this.readFile(path);
    } catch (cause) {
      throw new SandboxIoError({ path, op: "edit", reason: "read for edit failed", cause });
    }
    // Pure, shared transform (crown jewel). The provider owns the atomic
    // write — `writeFile` above does temp + `mv`.
    const result = applyEdits(source, edits);
    if (result.applied > 0) await this.writeFile(path, result.content);
    return result;
  }

  // ─── Runtime mounts — capability tier (ADR 59) ───
  // Docker cannot bind-mount a host dir onto a RUNNING container. Rather
  // than fake success (a silent lie), these throw SandboxUnsupportedError.
  // Create-time `mounts` (via `-v` at container create) DO work and are
  // honored by `resolveContainerPath`.

  async addMount(_mount: SandboxMount): Promise<void> {
    throw new SandboxUnsupportedError({
      capability:
        "addMount (docker cannot bind-mount a running container; declare create-time `mounts` instead)",
    });
  }

  async removeMount(_sandboxPath: string): Promise<void> {
    throw new SandboxUnsupportedError({
      capability: "removeMount (docker cannot unmount a running container)",
    });
  }

  async listMounts(): Promise<readonly SandboxMount[]> {
    throw new SandboxUnsupportedError({
      capability: "listMounts (docker runtime mounts unsupported; mounts are create-time only)",
    });
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.cleanupContainer) {
      try {
        await this.api.removeContainer(this.containerId, { force: true, v: true });
      } catch {
        // Container may already be gone.
      }
    }

    if (this.cleanupVolume && this.volumeName) {
      try {
        await this.api.removeVolume(this.volumeName);
      } catch {
        // Volume may already be gone.
      }
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async execInContainer(
    cmd: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const execId = await this.api.execCreate(this.containerId, {
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: this.workspacePath,
    });
    const result = await this.api.execStart(execId);
    const inspection = await this.api.execInspect(execId);
    return { stdout: result.stdout, stderr: result.stderr, exitCode: inspection.ExitCode };
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new SandboxIoError({
        path: this.workspacePath,
        op: "read",
        reason: `sandbox ${this.id} has been destroyed`,
      });
    }
  }
}

// ── Pure functions ─────────────────────────────────────────────────────────

/**
 * Resolve + validate a path within the container filesystem.
 *
 * All paths are POSIX (containers run Linux). String-based validation only
 * — no symlink resolution (that would require an exec inside the
 * container). The container itself is the isolation boundary; this is
 * defense-in-depth against a confused-deputy write outside the workspace.
 */
export function resolveContainerPath(
  inputPath: string,
  workspacePath: string,
  mode: "read" | "write",
  mounts: MountInfo[] = [],
): string {
  if (inputPath.includes("\0")) {
    throw new SandboxEscapeError({
      kind: "path-traversal",
      target: inputPath,
      detail: "null byte",
    });
  }

  const absolute = posix.isAbsolute(inputPath) ? inputPath : posix.join(workspacePath, inputPath);
  const resolved = posix.normalize(absolute);

  if (resolved === workspacePath || resolved.startsWith(workspacePath + "/")) {
    return resolved;
  }

  for (const mount of mounts) {
    if (resolved === mount.containerPath || resolved.startsWith(mount.containerPath + "/")) {
      if (mode === "write" && mount.readOnly) {
        throw new SandboxPermissionDeniedError({
          kind: "write",
          target: inputPath,
          cause: "policy",
        });
      }
      return resolved;
    }
  }

  throw new SandboxEscapeError({
    kind: "path-traversal",
    target: inputPath,
    detail: `resolves to ${resolved}, outside workspace + mounts`,
  });
}

/** Quote a string for safe use in `sh`. */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
