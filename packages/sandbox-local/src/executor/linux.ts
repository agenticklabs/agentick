/**
 * Linux executors — strategies `"bwrap"` and `"unshare"` (ADR 59, #240).
 *
 * Both prefix the argv with their namespace tool. Neither closes inherited
 * file descriptors, so a supervised process keeps its control channel across
 * the jail boundary — unverified on this repo's CI (no Linux host with a
 * namespace jail); see the package README.
 *
 * Ported from v1 `@agentick/sandbox-local/executor/linux.ts`.
 */

import type { SandboxStrategy } from "../platform/types.js";
import { buildBwrapArgs } from "../linux/bwrap.js";
import { buildUnshareArgs } from "../linux/unshare.js";
import type { CommandExecutor, JailedCommand, SpawnOptions } from "./types.js";

export class BwrapExecutor implements CommandExecutor {
  readonly strategy: SandboxStrategy = "bwrap";
  readonly shell = ["sh", "-c"] as const;

  wrap(command: string, args: readonly string[], options: SpawnOptions): JailedCommand {
    // bwrap sets the working directory itself, via `--chdir`.
    return { command: "bwrap", args: [...buildBwrapArgs(options), command, ...args] };
  }
}

export class UnshareExecutor implements CommandExecutor {
  readonly strategy: SandboxStrategy = "unshare";
  readonly shell = ["sh", "-c"] as const;

  wrap(command: string, args: readonly string[], options: SpawnOptions): JailedCommand {
    return {
      command: "unshare",
      args: [...buildUnshareArgs(options), command, ...args],
      cwd: options.cwd,
    };
  }
}
