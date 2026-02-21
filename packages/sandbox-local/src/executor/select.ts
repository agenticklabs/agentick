/**
 * Executor factory — select executor based on platform capabilities.
 */

import type { SandboxStrategy } from "../platform/types.js";
import type { CommandExecutor } from "./types.js";
import { BaseExecutor } from "./base.js";
import { DarwinExecutor } from "./darwin.js";
import { BwrapExecutor, UnshareExecutor } from "./linux.js";
import type { CgroupManager } from "../linux/cgroup.js";

/**
 * Create a CommandExecutor for the given strategy.
 * Optionally accepts a CgroupManager for Linux executors.
 */
export function selectExecutor(strategy: SandboxStrategy, cgroup?: CgroupManager): CommandExecutor {
  switch (strategy) {
    case "seatbelt":
      return new DarwinExecutor();
    case "bwrap":
      return new BwrapExecutor(cgroup);
    case "unshare":
      return new UnshareExecutor(cgroup);
    case "none":
      return new BaseExecutor();
  }
}
