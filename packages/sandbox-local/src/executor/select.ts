/**
 * Executor selector — maps a {@link SandboxStrategy} to its concrete
 * {@link CommandExecutor} (ADR 59, #240).
 *
 * Ported from v1 `@agentick/sandbox-local/executor/select.ts`.
 */

import type { SandboxStrategy } from "../platform/types.js";
import { BaseExecutor } from "./base.js";
import { DarwinExecutor } from "./darwin.js";
import { BwrapExecutor, UnshareExecutor } from "./linux.js";
import type { CommandExecutor } from "./types.js";

/** Create a {@link CommandExecutor} for the given strategy. */
export function selectExecutor(strategy: SandboxStrategy): CommandExecutor {
  switch (strategy) {
    case "seatbelt":
      return new DarwinExecutor();
    case "bwrap":
      return new BwrapExecutor();
    case "unshare":
      return new UnshareExecutor();
    case "none":
      return new BaseExecutor();
  }
}
