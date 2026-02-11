/**
 * Base (unsandboxed) executor.
 *
 * Plain child_process.spawn — no OS-level sandboxing.
 * Still benefits from workspace isolation, path validation, and timeout enforcement
 * provided by LocalSandbox.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { CommandExecutor, SpawnOptions } from "./types";
import type { SandboxStrategy } from "../platform/types";

export class BaseExecutor implements CommandExecutor {
  readonly strategy: SandboxStrategy = "none";

  spawn(command: string, options: SpawnOptions): ChildProcess {
    return spawn("sh", ["-c", command], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
  }
}
