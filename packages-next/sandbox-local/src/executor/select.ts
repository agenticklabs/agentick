/**
 * Executor selector — maps a {@link SandboxStrategy} to its concrete
 * {@link CommandExecutor} (ADR 59, #240). Linux executors accept an optional
 * {@link CgroupManager} for memory/CPU enforcement.
 *
 * Ported from v1 `@agentick/sandbox-local/executor/select.ts`.
 */

import type { SandboxStrategy } from "../platform/types.js";
import type { CgroupManager } from "../linux/cgroup.js";
import { BaseExecutor } from "./base.js";
import { DarwinExecutor } from "./darwin.js";
import { BwrapExecutor, UnshareExecutor } from "./linux.js";
import type { CommandExecutor } from "./types.js";

/** Create a {@link CommandExecutor} for the given strategy. */
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
