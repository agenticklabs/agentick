/**
 * `LocalSandbox` — a {@link SandboxHandle} backed by local OS primitives.
 *
 * `exec` spawns the command THROUGH a platform jail ({@link CommandExecutor}):
 * macOS seatbelt, Linux bwrap/unshare, or — where no jail primitive exists —
 * an honest unjailed passthrough. Whichever was selected is surfaced on
 * {@link isolation} so a caller can never mistake passthrough for confinement
 * (ADR 59: a jail that doesn't confine is worse than none). Streaming
 * (`onOutput`), `timeoutMs`/`signal` abort → `exitCode:124 signaled:true`,
 * `cwd`/`env`/`stdin`, and process-group tree-kill are owned by the handle,
 * not the jail.
 *
 * fs ops are path-confined to the workspace + allowed mounts; `writeFile` /
 * `editFile` write atomically (temp + rename — the file-wrapper the ADR says
 * the PROVIDER owns); mounts are dynamic. Resource limits map honestly:
 * `wallClockSec` → the per-exec timeout, `memoryMb`/`cpuPercent` → the Linux
 * {@link CgroupManager}, `diskMb` → the best-effort {@link DiskMonitor}.
 * `destroy` reaps processes, stops the proxy + disk monitor, tears down the
 * cgroup, disposes the executor, and removes an auto-created workspace.
 *
 * The `applyEdits` transform and the network matcher are pure, OS-free code
 * re-exported from the base package `@agentick/sandbox` — this handle
 * owns only the I/O around them.
 *
 * @see docs/proposals/v2/blueprint/59-sandbox-providers.md
 */

import type { ChildProcess } from "node:child_process";
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
import { applyEdits } from "@agentick/sandbox";
import type {
  NetworkRule,
  SandboxEdit,
  SandboxEditResult,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxHandle,
  SandboxMount,
} from "@agentick/sandbox";
import { SandboxIoError } from "@agentick/sandbox";
import type { CommandExecutor } from "./executor/types.js";
import type { CgroupManager } from "./linux/cgroup.js";
import { filterEnv, resolveSafePath } from "./paths.js";
import type { SandboxStrategy } from "./platform/types.js";
import type { NetworkProxyServer } from "./proxy.js";
import { DiskMonitor } from "./resources.js";
import { resolveMount, type ResolvedMount } from "./workspace.js";

/** Maximum captured output per stream (stdout/stderr) — 10MB. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface LocalSandboxInit {
  readonly id: string;
  readonly workspacePath: string;
  readonly env: Record<string, string>;
  readonly mounts: ResolvedMount[];
  /** The jail that wraps `exec`. Selected by the provider per host capability. */
  readonly executor: CommandExecutor;
  /** The effective isolation tier (mirrors `executor.strategy`; surfaced honestly). */
  readonly isolation: SandboxStrategy;
  /**
   * Egress policy passed to the jail. `false` → jail-level network deny
   * (seatbelt `deny network*` / no bwrap `--share-net`); `true`/`NetworkRule[]`
   * → jail allows egress (per-domain rules enforced by {@link proxy}).
   */
  readonly network: boolean | readonly NetworkRule[];
  readonly proxy?: NetworkProxyServer;
  /** Linux cgroup enforcing memoryMb/cpuPercent, torn down on destroy. */
  readonly cgroup?: CgroupManager;
  /** diskMb ceiling — enforced best-effort by a {@link DiskMonitor} poller. */
  readonly diskMb?: number;
  /** Default per-exec wall-clock ceiling (ms). Best-effort. */
  readonly defaultTimeoutMs?: number;
  readonly destroyWorkspace: () => Promise<void>;
}

export class LocalSandbox implements SandboxHandle {
  readonly id: string;
  readonly workspacePath: string;
  /**
   * The OS-isolation tier `exec` actually runs under. `"none"` means the
   * command is UNCONFINED (path-confined fs + proxied egress only) — read it
   * before trusting `exec` to confine. Never a false claim (ADR 59).
   */
  readonly isolation: SandboxStrategy;

  private readonly env: Record<string, string>;
  private readonly mounts: ResolvedMount[];
  private readonly executor: CommandExecutor;
  private readonly network: boolean | readonly NetworkRule[];
  private readonly proxy?: NetworkProxyServer;
  private readonly cgroup?: CgroupManager;
  private readonly defaultTimeoutMs?: number;
  private readonly _destroyWorkspace: () => Promise<void>;
  private readonly diskMonitor?: DiskMonitor;
  private readonly activeProcesses = new Set<ChildProcess>();
  private destroyed = false;

  constructor(init: LocalSandboxInit) {
    this.id = init.id;
    this.workspacePath = init.workspacePath;
    this.isolation = init.isolation;
    this.env = init.env;
    this.mounts = init.mounts;
    this.executor = init.executor;
    this.network = init.network;
    this.proxy = init.proxy;
    this.cgroup = init.cgroup;
    this.defaultTimeoutMs = init.defaultTimeoutMs;
    this._destroyWorkspace = init.destroyWorkspace;

    if (init.diskMb !== undefined) {
      this.diskMonitor = new DiskMonitor(this.workspacePath, init.diskMb, () =>
        this.killAll("SIGKILL"),
      );
      this.diskMonitor.start();
    }
  }

  async exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult> {
    this.assertAlive();
    const started = Date.now();

    const cwd = options?.cwd
      ? await resolveSafePath(options.cwd, this.workspacePath, "read", this.mounts)
      : this.workspacePath;

    const env = filterEnv({ ...this.env, ...(options?.env ?? {}) });

    // Spawn THROUGH the selected jail (seatbelt / bwrap / unshare / none).
    const child = this.executor.spawn(command, {
      cwd,
      env,
      workspacePath: this.workspacePath,
      mounts: this.mounts,
      network: this.network,
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

    this.diskMonitor?.stop();

    this.killAll("SIGTERM");
    if (this.activeProcesses.size > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.killAll("SIGKILL");
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
    await this.cgroup?.destroy();
    this.executor.dispose?.();
    await this._destroyWorkspace();
  }

  /** Kill every active child's process group. */
  private killAll(signal: NodeJS.Signals): void {
    for (const child of this.activeProcesses) this.killTree(child, signal);
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
