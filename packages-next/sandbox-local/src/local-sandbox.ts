/**
 * `LocalSandbox` — a {@link SandboxHandle} backed by local OS primitives.
 *
 * exec spawns `bash -c` in the workspace (streaming stdout/stderr through
 * `onOutput` as chunks arrive); fs ops are path-confined to the workspace +
 * allowed mounts; `writeFile`/`editFile` write atomically (temp + rename —
 * the file-wrapper the ADR says the PROVIDER owns); mounts are dynamic
 * (add/remove/list); `destroy` reaps child processes, stops the egress
 * proxy, and removes an auto-created workspace.
 *
 * The `applyEdits` transform and the network matcher are shared, pure,
 * OS-free packages (`sandbox-edit-next`, `sandbox-net-next`) — this handle
 * owns only the I/O around them.
 *
 * NOTE — isolation tier: this reference provider confines the FILE API by
 * path resolution and routes egress through the proxy, but `exec` runs as
 * an ordinary child process (no seatbelt/bwrap/namespace jail). It is the
 * capability baseline the conformance suite pins; hardened OS isolation is
 * a separate provider concern.
 * TODO(ADR 59): port v1's seatbelt/bwrap/unshare executor strategies +
 * cgroup resource enforcement as an opt-in isolation tier (see
 * `packages/sandbox-local/src/executor/*`, `linux/cgroup.ts`).
 *
 * @see docs/proposals/v2/blueprint/59-sandbox-providers.md
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile as fsReadFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { applyEdits } from "@agentick/sandbox-edit-next";
import type {
  SandboxEdit,
  SandboxEditResult,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxHandle,
  SandboxMount,
} from "@agentick/spec-next";
import { SandboxIoError } from "@agentick/spec-next";
import { filterEnv, resolveSafePath } from "./paths.js";
import { resolveMount, type ResolvedMount } from "./workspace.js";
import type { NetworkProxyServer } from "./proxy.js";

/** Maximum captured output per stream (stdout/stderr) — 10MB. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface LocalSandboxInit {
  readonly id: string;
  readonly workspacePath: string;
  readonly env: Record<string, string>;
  readonly mounts: ResolvedMount[];
  readonly proxy?: NetworkProxyServer;
  /** Default per-exec wall-clock ceiling (ms). Best-effort. */
  readonly defaultTimeoutMs?: number;
  readonly destroyWorkspace: () => Promise<void>;
}

export class LocalSandbox implements SandboxHandle {
  readonly id: string;
  readonly workspacePath: string;

  private readonly env: Record<string, string>;
  private readonly mounts: ResolvedMount[];
  private readonly proxy?: NetworkProxyServer;
  private readonly defaultTimeoutMs?: number;
  private readonly _destroyWorkspace: () => Promise<void>;
  private readonly activeProcesses = new Set<ChildProcess>();
  private destroyed = false;

  constructor(init: LocalSandboxInit) {
    this.id = init.id;
    this.workspacePath = init.workspacePath;
    this.env = init.env;
    this.mounts = init.mounts;
    this.proxy = init.proxy;
    this.defaultTimeoutMs = init.defaultTimeoutMs;
    this._destroyWorkspace = init.destroyWorkspace;
  }

  async exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult> {
    this.assertAlive();
    const started = Date.now();

    const cwd = options?.cwd
      ? await resolveSafePath(options.cwd, this.workspacePath, "read", this.mounts)
      : this.workspacePath;

    const env = filterEnv({ ...this.env, ...(options?.env ?? {}) });

    const child = spawn("bash", ["-c", command], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group → we can kill the whole tree
    });
    this.activeProcesses.add(child);

    // Timeout + external-abort → kill the process group.
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const signals: AbortSignal[] = [];
    if (timeoutMs !== undefined) signals.push(AbortSignal.timeout(timeoutMs));
    if (options?.signal) signals.push(options.signal);
    const abort = signals.length > 0 ? AbortSignal.any(signals) : undefined;

    let killed = false;
    const onAbort = (): void => {
      killed = true;
      this.killTree(child, "SIGTERM");
    };
    abort?.addEventListener("abort", onAbort, { once: true });

    if (options?.stdin !== undefined) {
      child.stdin?.write(options.stdin);
    }
    child.stdin?.end();

    const stdout = new OutputCollector(MAX_OUTPUT_BYTES, "stdout", options?.onOutput);
    const stderr = new OutputCollector(MAX_OUTPUT_BYTES, "stderr", options?.onOutput);
    child.stdout?.on("data", (c: Buffer) => stdout.write(c));
    child.stderr?.on("data", (c: Buffer) => stderr.write(c));

    const { exitCode, signaled } = await new Promise<{ exitCode: number; signaled: boolean }>(
      (resolve) => {
        child.on("close", (code, signal) => {
          this.activeProcesses.delete(child);
          resolve({
            exitCode: code ?? (killed ? 124 : 1),
            signaled: signal !== null || killed,
          });
        });
        child.on("error", () => {
          this.activeProcesses.delete(child);
          resolve({ exitCode: killed ? 124 : 1, signaled: killed });
        });
      },
    );
    abort?.removeEventListener("abort", onAbort);

    return {
      stdout: stdout.toString(),
      stderr: stderr.toString() + (killed ? "\n[sandbox: command aborted / timed out]" : ""),
      exitCode,
      signaled,
      durationMs: Date.now() - started,
    };
  }

  async readFile(path: string): Promise<string> {
    this.assertAlive();
    const resolved = await resolveSafePath(path, this.workspacePath, "read", this.mounts);
    try {
      return await fsReadFile(resolved, "utf-8");
    } catch (cause) {
      throw new SandboxIoError({ path, op: "read", reason: "read failed", cause });
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.assertAlive();
    const resolved = await resolveSafePath(path, this.workspacePath, "write", this.mounts);
    await mkdir(dirname(resolved), { recursive: true });
    await this.atomicWrite(path, resolved, content);
  }

  async editFile(path: string, edits: readonly SandboxEdit[]): Promise<SandboxEditResult> {
    this.assertAlive();
    const resolved = await resolveSafePath(path, this.workspacePath, "write", this.mounts);
    let source: string;
    try {
      source = await fsReadFile(resolved, "utf-8");
    } catch (cause) {
      throw new SandboxIoError({ path, op: "edit", reason: "read for edit failed", cause });
    }
    // Pure, shared transform (crown jewel). Provider owns the atomic write.
    const result = applyEdits(source, edits);
    if (result.applied > 0) await this.atomicWrite(path, resolved, result.content);
    return result;
  }

  /**
   * Atomic write — temp file in the same dir + rename. Falls back to a
   * direct write for NFS/FUSE I/O errors where temp+rename can fail.
   */
  private async atomicWrite(path: string, resolved: string, content: string): Promise<void> {
    const tmp = join(dirname(resolved), `.write-${randomBytes(6).toString("hex")}.tmp`);
    try {
      await fsWriteFile(tmp, content, "utf-8");
      await rename(tmp, resolved);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EIO" || code === "ENOENT" || code === "EXDEV") {
        try {
          await fsWriteFile(resolved, content, "utf-8");
          return;
        } catch (cause) {
          throw new SandboxIoError({ path, op: "write", reason: "write failed", cause });
        }
      }
      throw new SandboxIoError({ path, op: "write", reason: "atomic write failed", cause: err });
    }
  }

  // ─── Dynamic mounts (capability tier) ───
  // A local mount extends the confinement allow-set and (when the sandbox
  // path differs) symlinks the sandbox path to the host dir so the agent
  // reaches it at a clean path. No namespaces — the honest local capability.

  async addMount(mount: SandboxMount): Promise<void> {
    this.assertAlive();
    const resolved = await resolveMount(mount);

    const existingIdx = this.mounts.findIndex((m) => m.sandboxPath === resolved.sandboxPath);
    if (existingIdx !== -1) this.mounts[existingIdx] = resolved;
    else this.mounts.push(resolved);

    if (mount.sandboxPath !== resolved.hostPath) {
      const linkPath = isAbsolute(mount.sandboxPath)
        ? mount.sandboxPath
        : join(this.workspacePath, mount.sandboxPath);
      const exists = await lstat(linkPath).catch(() => null);
      if (!exists) {
        await mkdir(dirname(linkPath), { recursive: true });
        await symlink(resolved.hostPath, linkPath).catch(() => {
          // Symlink failed — the mount still works via the host path.
        });
      }
    }
  }

  async removeMount(sandboxPath: string): Promise<void> {
    this.assertAlive();
    const idx = this.mounts.findIndex((m) => m.sandboxPath === sandboxPath);
    if (idx === -1) return;
    this.mounts.splice(idx, 1);
    const linkPath = isAbsolute(sandboxPath) ? sandboxPath : join(this.workspacePath, sandboxPath);
    const stat = await lstat(linkPath).catch(() => null);
    if (stat?.isSymbolicLink()) await rm(linkPath, { force: true }).catch(() => {});
  }

  async listMounts(): Promise<readonly SandboxMount[]> {
    return this.mounts.map((m) => ({
      hostPath: m.hostPath,
      sandboxPath: m.sandboxPath,
      readOnly: m.readOnly,
    }));
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    for (const child of this.activeProcesses) this.killTree(child, "SIGTERM");
    if (this.activeProcesses.size > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          for (const child of this.activeProcesses) this.killTree(child, "SIGKILL");
          resolve();
        }, 5000);
        timer.unref();
        const check = setInterval(() => {
          if (this.activeProcesses.size === 0) {
            clearTimeout(timer);
            clearInterval(check);
            resolve();
          }
        }, 50);
        check.unref();
      });
    }

    await this.proxy?.stop();
    await this._destroyWorkspace();
  }

  /** Kill the child's whole process group (spawned detached). */
  private killTree(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      child.kill(signal);
    }
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

/** Collects a stream with a byte cap and an optional live-output callback. */
class OutputCollector {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private truncated = false;

  constructor(
    private readonly maxBytes: number,
    private readonly stream: "stdout" | "stderr",
    private readonly onOutput?: (chunk: { stream: "stdout" | "stderr"; chunk: string }) => void,
  ) {}

  write(chunk: Buffer): void {
    // Always stream to the callback, even past the collection cap.
    this.onOutput?.({ stream: this.stream, chunk: chunk.toString() });
    if (this.truncated) return;
    if (this.bytes + chunk.length > this.maxBytes) {
      const remaining = this.maxBytes - this.bytes;
      if (remaining > 0) {
        this.chunks.push(chunk.subarray(0, remaining));
        this.bytes += remaining;
      }
      this.truncated = true;
    } else {
      this.chunks.push(chunk);
      this.bytes += chunk.length;
    }
  }

  toString(): string {
    const content = Buffer.concat(this.chunks).toString();
    return this.truncated ? content + "\n[sandbox: output truncated at 10MB]" : content;
  }
}
