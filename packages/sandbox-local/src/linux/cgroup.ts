/**
 * cgroups v2 resource-limit manager (Linux, ADR 59, #240).
 *
 * Creates a cgroup under `/sys/fs/cgroup/agentick-<id>` and writes the ADR 59
 * {@link SandboxResourceLimits} onto its controllers:
 *   - `memoryMb`   → `memory.max` (bytes)
 *   - `cpuPercent` → `cpu.max` ("<quota> <period>" µs; 100% = one core)
 *
 * `diskMb` (no cgroup disk-quota controller in the common case) is enforced
 * best-effort by the {@link import("../resources.js").DiskMonitor} poller;
 * `wallClockSec` is enforced by the handle's per-exec timeout. Both are NOT
 * cgroup concerns and are intentionally absent here.
 *
 * Degrades gracefully: if `/sys/fs/cgroup` is not writable (unprivileged
 * host, no delegation), `create` no-ops and `addProcess` becomes a no-op —
 * the jail still confines; only the resource ceiling is best-effort. This is
 * surfaced (`created` stays false), never a silent false claim.
 *
 * Ported from v1 `@agentick/sandbox-local/linux/cgroup.ts`, retyped to
 * `SandboxResourceLimits` (memoryMb/cpuPercent) from v1's `ResourceLimits`.
 */

import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { SandboxResourceLimits } from "@agentick/sandbox";

const CGROUP_BASE = "/sys/fs/cgroup";

/** cpu.max period (µs). 100ms window; quota = cpuPercent% of one core. */
const CPU_PERIOD_US = 100_000;

export class CgroupManager {
  private readonly cgroupPath: string;
  private created = false;

  constructor(private readonly id: string) {
    this.cgroupPath = join(CGROUP_BASE, `agentick-${id}`);
  }

  /** True once the cgroup exists and limits were applied. */
  get isActive(): boolean {
    return this.created;
  }

  /**
   * Create the cgroup directory and apply resource limits. No-op if cgroups
   * v2 is unavailable or not writable (degrades to best-effort; never lies).
   */
  async create(limits: SandboxResourceLimits): Promise<void> {
    try {
      await access(CGROUP_BASE, constants.W_OK);
    } catch {
      // cgroups not writable — degrade gracefully (created stays false).
      return;
    }

    try {
      await mkdir(this.cgroupPath, { recursive: true });
      this.created = true;

      if (limits.memoryMb !== undefined) {
        await writeFile(join(this.cgroupPath, "memory.max"), String(limits.memoryMb * 1024 * 1024));
      }

      if (limits.cpuPercent !== undefined) {
        const quota = Math.round((limits.cpuPercent / 100) * CPU_PERIOD_US);
        await writeFile(join(this.cgroupPath, "cpu.max"), `${quota} ${CPU_PERIOD_US}`);
      }
    } catch (err) {
      console.warn(`[sandbox-local-next] failed to create cgroup ${this.cgroupPath}:`, err);
      this.created = false;
    }
  }

  /** Move a process into this cgroup. No-op if the cgroup wasn't created. */
  async addProcess(pid: number): Promise<void> {
    if (!this.created) return;
    try {
      await writeFile(join(this.cgroupPath, "cgroup.procs"), String(pid));
    } catch {
      // Process may have already exited.
    }
  }

  /** Remove the cgroup directory. Best-effort. */
  async destroy(): Promise<void> {
    if (!this.created) return;
    try {
      await rm(this.cgroupPath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
    this.created = false;
  }
}
