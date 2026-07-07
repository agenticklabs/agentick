/**
 * Linux executors — strategies `"bwrap"` and `"unshare"` (ADR 59, #240).
 *
 * Both spawn `sh -c <command>` wrapped by their namespace tool and, when a
 * {@link CgroupManager} is supplied, move the child into the cgroup for
 * memory/CPU enforcement. Children are detached (own process group) so the
 * handle can kill the tree on timeout/abort.
 *
 * Ported from v1 `@agentick/sandbox-local/executor/linux.ts`.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { SandboxStrategy } from "../platform/types.js";
import type { CgroupManager } from "../linux/cgroup.js";
import { buildBwrapArgs } from "../linux/bwrap.js";
import { buildUnshareArgs } from "../linux/unshare.js";
import type { CommandExecutor, SpawnOptions } from "./types.js";

export class BwrapExecutor implements CommandExecutor {
  readonly strategy: SandboxStrategy = "bwrap";

  constructor(private readonly cgroup?: CgroupManager) {}

  spawn(command: string, options: SpawnOptions): ChildProcess {
    const args = buildBwrapArgs(options);
    args.push("sh", "-c", command);

    // bwrap sets the working directory via `--chdir` (in the args), so cwd
    // is deliberately not passed to spawn here.
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

  constructor(private readonly cgroup?: CgroupManager) {}

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
