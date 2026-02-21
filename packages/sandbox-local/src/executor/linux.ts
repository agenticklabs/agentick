/**
 * Linux Executor (bubblewrap / unshare)
 *
 * Spawns commands under bwrap or unshare for namespace-based isolation.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { CommandExecutor, SpawnOptions } from "./types.js";
import type { SandboxStrategy } from "../platform/types.js";
import { buildBwrapArgs } from "../linux/bwrap.js";
import { buildUnshareArgs } from "../linux/unshare.js";
import type { CgroupManager } from "../linux/cgroup.js";

export class BwrapExecutor implements CommandExecutor {
  readonly strategy: SandboxStrategy = "bwrap";
  private cgroup?: CgroupManager;

  constructor(cgroup?: CgroupManager) {
    this.cgroup = cgroup;
  }

  spawn(command: string, options: SpawnOptions): ChildProcess {
    const args = buildBwrapArgs(options);
    args.push("sh", "-c", command);

    const child = spawn("bwrap", args, {
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    if (this.cgroup && child.pid) {
      this.cgroup.addProcess(child.pid).catch(() => {});
    }

    return child;
  }
}

export class UnshareExecutor implements CommandExecutor {
  readonly strategy: SandboxStrategy = "unshare";
  private cgroup?: CgroupManager;

  constructor(cgroup?: CgroupManager) {
    this.cgroup = cgroup;
  }

  spawn(command: string, options: SpawnOptions): ChildProcess {
    const args = buildUnshareArgs(options);
    args.push("sh", "-c", command);

    const child = spawn("unshare", args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    if (this.cgroup && child.pid) {
      this.cgroup.addProcess(child.pid).catch(() => {});
    }

    return child;
  }
}
