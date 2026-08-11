/**
 * Base (unjailed) executor — strategy `"none"` (ADR 59, #240).
 *
 * The argv passes through untouched. NO OS-level jail: the file API is still
 * path-confined by the handle and egress is still proxied, but a spawned
 * process runs UNCONFINED. Selected only when no jail primitive is available
 * on the host; the handle surfaces `isolation: "none"` so this is never
 * mistaken for confinement (ADR 59 — a jail that doesn't confine is worse
 * than none).
 *
 * Ported from v1 `@agentick/sandbox-local/executor/base.ts`.
 */

import type { SandboxStrategy } from "../platform/types.js";
import type { CommandExecutor, JailedCommand, SpawnOptions } from "./types.js";

export class BaseExecutor implements CommandExecutor {
  readonly strategy: SandboxStrategy = "none";
  readonly shell = ["bash", "-c"] as const;

  wrap(command: string, args: readonly string[], options: SpawnOptions): JailedCommand {
    return { command, args, cwd: options.cwd };
  }
}
