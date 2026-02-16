/**
 * LocalSandbox — implements the Sandbox contract using local OS primitives.
 */

import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { SandboxHandle, ExecOptions, ExecResult, OutputChunk, Mount } from "@agentick/sandbox";
import type { Edit, EditResult } from "@agentick/sandbox";
import { applyEdits, SandboxAccessError } from "@agentick/sandbox";
import type { CommandExecutor, ResolvedMount, ResolvedPermissions } from "./executor/types";
import type { ResourceEnforcer } from "./resources";
import { resolveSafePath, filterEnv } from "./paths";
import { resolveMounts } from "./workspace";
import type { NetworkProxyServer } from "./network/proxy";

/** Maximum output per stream (stdout/stderr) — 10MB. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface LocalSandboxInit {
  id: string;
  workspacePath: string;
  executor: CommandExecutor;
  env: Record<string, string>;
  mounts: ResolvedMount[];
  permissions: ResolvedPermissions;
  resources: ResourceEnforcer;
  proxy?: NetworkProxyServer;
  cleanupWorkspace: boolean;
  destroyWorkspace: () => Promise<void>;
}

export class LocalSandbox implements SandboxHandle {
  readonly id: string;
  readonly workspacePath: string;

  private readonly executor: CommandExecutor;
  private readonly env: Record<string, string>;
  private readonly mounts: ResolvedMount[];
  private readonly permissions: ResolvedPermissions;
  private readonly resources: ResourceEnforcer;
  private readonly proxy?: NetworkProxyServer;
  private readonly cleanupWorkspace: boolean;
  private readonly _destroyWorkspace: () => Promise<void>;
  private activeProcesses = new Set<ChildProcess>();
  private oneTimeAllows = new Set<string>();
  private destroyed = false;

  constructor(init: LocalSandboxInit) {
    this.id = init.id;
    this.workspacePath = init.workspacePath;
    this.executor = init.executor;
    this.env = init.env;
    this.mounts = init.mounts;
    this.permissions = init.permissions;
    this.resources = init.resources;
    this.proxy = init.proxy;
    this.cleanupWorkspace = init.cleanupWorkspace;
    this._destroyWorkspace = init.destroyWorkspace;
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    this.assertAlive();

    const cwd = options?.cwd
      ? await resolveSafePath(options.cwd, this.workspacePath, "read", this.mounts)
      : this.workspacePath;

    // Merge environment: base + proxy vars + per-command overrides
    const env = filterEnv({
      ...this.env,
      ...(options?.env ?? {}),
    });

    const child = this.executor.spawn(command, {
      cwd,
      env,
      workspacePath: this.workspacePath,
      mounts: this.mounts,
      permissions: this.permissions,
    });

    this.activeProcesses.add(child);
    this.resources.trackProcess(child);

    // Set up timeout
    const timeoutSignal = this.resources.createTimeoutSignal(options?.timeout);
    let timedOut = false;
    const abortHandler = () => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
    timeoutSignal?.addEventListener("abort", abortHandler, { once: true });

    // Collect output with cap
    const stdout = new OutputCollector(MAX_OUTPUT_BYTES, "stdout", options?.onOutput);
    const stderr = new OutputCollector(MAX_OUTPUT_BYTES, "stderr", options?.onOutput);

    child.stdout?.on("data", (chunk: Buffer) => stdout.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.write(chunk));

    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", (code) => {
        this.activeProcesses.delete(child);
        resolve(code ?? (timedOut ? 124 : 1));
      });
      child.on("error", () => {
        this.activeProcesses.delete(child);
        resolve(timedOut ? 124 : 1);
      });
    });

    timeoutSignal?.removeEventListener("abort", abortHandler);

    return {
      stdout: stdout.toString(),
      stderr: stderr.toString() + (timedOut ? "\n[sandbox: command timed out]" : ""),
      exitCode,
    };
  }

  async readFile(path: string): Promise<string> {
    this.assertAlive();
    const resolved = await this.resolveWithAllows(path, "read");
    return readFile(resolved, "utf-8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.assertAlive();
    const resolved = await this.resolveWithAllows(path, "write");

    // Ensure parent directory exists
    await mkdir(dirname(resolved), { recursive: true });

    // Atomic write: temp + rename
    const tmp = join(dirname(resolved), `.write-${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(tmp, content, "utf-8");
      await rename(tmp, resolved);
    } catch (err) {
      try {
        await unlink(tmp);
      } catch {
        // Ignore cleanup errors
      }
      throw err;
    }
  }

  async editFile(path: string, edits: Edit[]): Promise<EditResult> {
    this.assertAlive();
    const resolved = await this.resolveWithAllows(path, "write");

    const source = await readFile(resolved, "utf-8");
    const result = applyEdits(source, edits);
    if (result.applied === 0) return result;

    // Atomic write
    const tmp = join(dirname(resolved), `.edit-${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(tmp, result.content, "utf-8");
      await rename(tmp, resolved);
    } catch (err) {
      try {
        await unlink(tmp);
      } catch {
        // Ignore cleanup errors
      }
      throw err;
    }

    return result;
  }

  /**
   * Resolve path with one-time allow check.
   *
   * On SandboxAccessError:
   * - If resolvedPath is in oneTimeAllows → consume it, return path (no mount)
   * - Otherwise → attach recover() and re-throw for upstream recovery
   *
   * One-time allows are consumed atomically (single-threaded JS) to prevent
   * parallel tool calls from piggybacking on another call's temporary access.
   */
  private async resolveWithAllows(path: string, mode: "read" | "write"): Promise<string> {
    try {
      return await resolveSafePath(path, this.workspacePath, mode, this.mounts);
    } catch (err) {
      if (err instanceof SandboxAccessError) {
        // Check one-time allowlist (consumed on use)
        if (this.oneTimeAllows.has(err.resolvedPath)) {
          this.oneTimeAllows.delete(err.resolvedPath);
          return err.resolvedPath;
        }

        // Attach recovery function for upstream (tool executor) to call
        err.recover = async (always: boolean) => {
          const dir = dirname(err.resolvedPath);
          const mountMode = mode === "write" ? "rw" : "ro";
          if (always) {
            await this.addMount({ host: dir, sandbox: dir, mode: mountMode });
          } else {
            this.oneTimeAllows.add(err.resolvedPath);
            return () => {
              this.oneTimeAllows.delete(err.resolvedPath);
            };
          }
        };
      }
      throw err;
    }
  }

  async addMount(mount: Mount): Promise<void> {
    this.assertAlive();
    const [resolved] = await resolveMounts([mount]);
    // Consolidate: remove any existing mounts that are children of the new one
    for (let i = this.mounts.length - 1; i >= 0; i--) {
      const existing = this.mounts[i]!;
      if (existing.hostPath.startsWith(resolved.hostPath + "/")) {
        this.mounts.splice(i, 1);
      }
    }
    // Don't add if already mounted (exact match)
    if (!this.mounts.some((m) => m.hostPath === resolved.hostPath)) {
      this.mounts.push(resolved);
    }
  }

  removeMount(hostPath: string): void {
    this.assertAlive();
    const idx = this.mounts.findIndex((m) => m.hostPath === hostPath);
    if (idx !== -1) this.mounts.splice(idx, 1);
  }

  listMounts(): Mount[] {
    return this.mounts.map((m) => ({
      host: m.hostPath,
      sandbox: m.sandboxPath,
      mode: m.mode,
    }));
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    // Kill all active processes
    for (const child of this.activeProcesses) {
      try {
        if (child.pid) {
          process.kill(-child.pid, "SIGTERM");
        }
      } catch {
        child.kill("SIGTERM");
      }
    }

    // Force-kill after 5s
    if (this.activeProcesses.size > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          for (const child of this.activeProcesses) {
            try {
              if (child.pid) process.kill(-child.pid, "SIGKILL");
            } catch {
              // Already gone
            }
          }
          resolve();
        }, 5000);
        timer.unref();

        // Also resolve early if all processes exit
        const check = setInterval(() => {
          if (this.activeProcesses.size === 0) {
            clearTimeout(timer);
            clearInterval(check);
            resolve();
          }
        }, 100);
        check.unref();
      });
    }

    // Stop proxy
    await this.proxy?.stop();

    // Stop resource enforcement
    await this.resources.stop();

    // Remove workspace
    await this._destroyWorkspace();
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error(`Sandbox ${this.id} has been destroyed`);
    }
  }
}

/**
 * Collects output from a stream with a byte cap and optional streaming callback.
 */
class OutputCollector {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private truncated = false;

  constructor(
    private readonly maxBytes: number,
    private readonly stream: "stdout" | "stderr",
    private readonly onOutput?: (chunk: OutputChunk) => void,
  ) {}

  write(chunk: Buffer): void {
    // Always stream to callback (even if we've hit the cap for collection)
    this.onOutput?.({ stream: this.stream, data: chunk.toString() });

    if (this.truncated) return;

    if (this.bytes + chunk.length > this.maxBytes) {
      // Take what we can
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
