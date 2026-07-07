/**
 * Base (unjailed) executor — strategy `"none"` (ADR 59, #240).
 *
 * A plain `bash -c` child in its own process group. NO OS-level jail: the
 * file API is still path-confined by the handle and egress is still proxied,
 * but `exec` runs UNCONFINED. Selected only when no jail primitive is
 * available on the host; the handle surfaces `isolation: "none"` so this is
 * never mistaken for confinement (ADR 59 — a jail that doesn't confine is
 * worse than none).
 *
 * Ported from v1 `@agentick/sandbox-local/executor/base.ts`.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { SandboxStrategy } from "../platform/types.js";
import type { CommandExecutor, SpawnOptions } from "./types.js";

export class BaseExecutor implements CommandExecutor {
  readonly strategy: SandboxStrategy = "none";

  spawn(command: string, options: SpawnOptions): ChildProcess {
    return spawn("bash", ["-c", command], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group → the handle can kill the whole tree
    });
  }
}
