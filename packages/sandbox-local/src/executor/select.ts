/**
 * Executor factory — select executor based on platform capabilities.
 */

import type { SandboxStrategy } from "../platform/types";
import type { CommandExecutor } from "./types";
import { BaseExecutor } from "./base";
import { DarwinExecutor } from "./darwin";
import { BwrapExecutor, UnshareExecutor } from "./linux";
import { CgroupManager } from "../linux/cgroup";

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
