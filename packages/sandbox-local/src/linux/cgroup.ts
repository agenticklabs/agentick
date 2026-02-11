/**
 * cgroups v2 Resource Limit Manager
 *
 * Creates a cgroup under /sys/fs/cgroup/ for enforcing memory, CPU, and
 * process limits. Degrades gracefully if the cgroup directory is not writable.
 */

import { mkdir, writeFile, rm, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { ResourceLimits } from "@agentick/sandbox";

const CGROUP_BASE = "/sys/fs/cgroup";

export class CgroupManager {
  private readonly cgroupPath: string;
  private created = false;

  constructor(private readonly id: string) {
    this.cgroupPath = join(CGROUP_BASE, `agentick-${id}`);
  }

  /**
   * Create the cgroup directory and apply resource limits.
   * No-op if cgroups v2 is not available or not writable.
   */
  async create(limits: ResourceLimits): Promise<void> {
    try {
      await access(CGROUP_BASE, constants.W_OK);
    } catch {
      // cgroups not writable — degrade gracefully
      return;
    }

    try {
      await mkdir(this.cgroupPath, { recursive: true });
      this.created = true;

      if (limits.memory) {
        await writeFile(join(this.cgroupPath, "memory.max"), String(limits.memory));
      }

      if (limits.cpu) {
        // cpu.max format: "quota period" (microseconds)
        const period = 100_000; // 100ms
        const quota = Math.round(limits.cpu * period);
        await writeFile(join(this.cgroupPath, "cpu.max"), `${quota} ${period}`);
      }

      if (limits.maxProcesses) {
        await writeFile(join(this.cgroupPath, "pids.max"), String(limits.maxProcesses));
      }
    } catch (err) {
      console.warn(`[sandbox-local] Failed to create cgroup ${this.cgroupPath}:`, err);
      this.created = false;
    }
  }

  /**
   * Add a process to this cgroup.
   */
  async addProcess(pid: number): Promise<void> {
    if (!this.created) return;

    try {
      await writeFile(join(this.cgroupPath, "cgroup.procs"), String(pid));
    } catch {
      // Process may have already exited
    }
  }

  /**
   * Destroy the cgroup directory.
   */
  async destroy(): Promise<void> {
    if (!this.created) return;

    try {
      await rm(this.cgroupPath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
    this.created = false;
  }
}
