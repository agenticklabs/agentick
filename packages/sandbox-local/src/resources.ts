/**
 * Resource Enforcement
 *
 * Timeout management, disk monitoring, and process tracking.
 * cgroups-based limits are handled separately by CgroupManager (Linux only).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChildProcess } from "node:child_process";
import type { ResourceLimits } from "@agentick/sandbox";

const execFileAsync = promisify(execFile);

const DISK_POLL_INTERVAL = 5000; // 5 seconds

export class ResourceEnforcer {
  private readonly workspacePath: string;
  private readonly limits: ResourceLimits;
  private diskTimer?: ReturnType<typeof setInterval>;
  private trackedProcesses = new Set<ChildProcess>();
  private stopped = false;

  constructor(workspacePath: string, limits: ResourceLimits) {
    this.workspacePath = workspacePath;
    this.limits = limits;
  }

  /** Start resource monitoring. */
  async start(): Promise<void> {
    if (this.limits.disk) {
      this.diskTimer = setInterval(() => this.checkDisk(), DISK_POLL_INTERVAL);
      this.diskTimer.unref();
    }
  }

  /** Track a child process for cleanup on resource violations. */
  trackProcess(child: ChildProcess): void {
    this.trackedProcesses.add(child);
    child.on("exit", () => this.trackedProcesses.delete(child));
  }

  /**
   * Create an AbortSignal that fires after the given timeout.
   * Falls back to the global timeout limit if no per-command timeout.
   */
  createTimeoutSignal(timeout?: number): AbortSignal | undefined {
    const ms = timeout ?? this.limits.timeout;
    if (!ms) return undefined;
    return AbortSignal.timeout(ms);
  }

  /** Stop all monitoring and kill tracked processes. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    if (this.diskTimer) {
      clearInterval(this.diskTimer);
      this.diskTimer = undefined;
    }

    this.killAllProcesses();
  }

  private async checkDisk(): Promise<void> {
    if (!this.limits.disk || this.stopped) return;

    try {
      // du -sk works on both macOS and Linux (-sb is Linux-only)
      const { stdout } = await execFileAsync("du", ["-sk", this.workspacePath]);
      const bytes = parseInt(stdout.split("\t")[0], 10) * 1024;
      if (bytes > this.limits.disk!) {
        this.killAllProcesses();
      }
    } catch {
      // du may fail if workspace was destroyed — ignore
    }
  }

  private killAllProcesses(): void {
    for (const child of this.trackedProcesses) {
      try {
        // Kill process group if possible
        if (child.pid) {
          process.kill(-child.pid, "SIGTERM");
        }
      } catch {
        // Process may have already exited
      }

      // Forceful kill after 5 seconds
      setTimeout(() => {
        try {
          if (child.pid) {
            process.kill(-child.pid, "SIGKILL");
          }
        } catch {
          // Already gone
        }
      }, 5000).unref();
    }
  }
}
