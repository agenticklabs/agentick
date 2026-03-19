/**
 * SecureExecSandbox
 *
 * Implements the Sandbox interface using a secure-exec NodeRuntime.
 * The runtime is reused across exec() calls (state persists).
 * File operations bypass the isolate — they operate directly on the VFS.
 */

import type { NodeRuntime } from "secure-exec";
import type {
  SandboxHandle,
  ExecOptions,
  ExecResult,
  Mount,
  Edit,
  EditResult,
} from "@agentick/sandbox";
import { applyEdits } from "@agentick/sandbox";
import type { MountAwareVFS } from "./filesystem.js";
import type { PersistenceAdapter } from "./types.js";

/** Maximum output per stream (stdout/stderr) in bytes. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB

export class SecureExecSandbox implements SandboxHandle {
  readonly id: string;
  readonly workspacePath: string;

  private destroyed = false;
  private execQueue: Promise<void> = Promise.resolve();

  constructor(
    id: string,
    workspacePath: string,
    private readonly runtime: NodeRuntime,
    private readonly vfs: MountAwareVFS,
    private readonly persistence?: PersistenceAdapter,
  ) {
    this.id = id;
    this.workspacePath = workspacePath;
  }

  // ── exec ──────────────────────────────────────────────────────────────

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    this.assertAlive();

    // Serialize concurrent exec calls
    const result = new Promise<ExecResult>((resolve, reject) => {
      this.execQueue = this.execQueue.then(async () => {
        try {
          resolve(await this.doExec(command, options));
        } catch (err) {
          reject(err);
        }
      });
    });

    return result;
  }

  private async doExec(code: string, options?: ExecOptions): Promise<ExecResult> {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeoutMs = options?.timeout;
    const abortController = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        abortController.abort();
      }, timeoutMs);
    }

    try {
      const execResult = await this.runtime.exec(code, {
        cwd: options?.cwd ?? this.workspacePath,
        env: options?.env,
        cpuTimeLimitMs: timeoutMs,
        onStdio: (event) => {
          const chunk = event.message;
          if (event.channel === "stdout") {
            if (stdout.length < MAX_OUTPUT_BYTES) {
              stdout += chunk;
              options?.onOutput?.({ stream: "stdout", data: chunk });
            }
          } else {
            if (stderr.length < MAX_OUTPUT_BYTES) {
              stderr += chunk;
              options?.onOutput?.({ stream: "stderr", data: chunk });
            }
          }
        },
      });

      if (timedOut) {
        stderr += "\n[timeout: execution exceeded time limit]";
        return { stdout, stderr, exitCode: 124 };
      }

      return {
        stdout,
        stderr,
        exitCode: execResult.code,
      };
    } catch (err) {
      if (timedOut) {
        stderr += "\n[timeout: execution exceeded time limit]";
        return { stdout, stderr, exitCode: 124 };
      }

      // CPU time limit exceeded returns code 124
      if (err instanceof Error && err.message.includes("CPU time limit")) {
        stderr += `\n${err.message}`;
        return { stdout, stderr, exitCode: 124 };
      }

      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ── File operations (bypass isolate) ──────────────────────────────────

  async readFile(filePath: string): Promise<string> {
    this.assertAlive();
    try {
      return await this.vfs.readTextFile(filePath);
    } catch (err) {
      const error = new Error(`File not found: ${filePath}`);
      (error as NodeJS.ErrnoException).code = "ENOENT";
      throw error;
    }
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    this.assertAlive();
    await this.vfs.writeFile(filePath, content);
  }

  async editFile(filePath: string, edits: Edit[]): Promise<EditResult> {
    this.assertAlive();
    const original = await this.readFile(filePath);
    const result = applyEdits(original, edits);
    if (result.applied > 0) {
      await this.writeFile(filePath, result.content);
    }
    return result;
  }

  // ── Mount management ──────────────────────────────────────────────────

  async addMount(mount: Mount): Promise<void> {
    this.assertAlive();
    this.vfs.addMount(mount);
  }

  removeMount(hostPath: string): void {
    this.vfs.removeMount(hostPath);
  }

  listMounts(): Mount[] {
    return this.vfs.listMounts();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    // Wait for any in-flight exec to complete
    try {
      await this.execQueue;
    } catch {
      // Ignore exec errors during shutdown
    }

    // Save VFS state if persistence configured
    if (this.persistence) {
      try {
        await this.persistence.save(this.id, this.vfs);
      } catch {
        // Best-effort persistence
      }
    }

    await this.runtime.terminate();
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error(`Sandbox ${this.id} has been destroyed`);
    }
  }
}
