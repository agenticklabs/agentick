/**
 * macOS seatbelt executor — strategy `"seatbelt"` (ADR 59, #240).
 *
 * Compiles a per-exec SBPL profile from {@link SpawnOptions}, writes it to a
 * per-instance temp dir (mode 0700, profile files 0600), and spawns the
 * command under `sandbox-exec -f <profile> /bin/bash -c <command>`. The
 * profile is removed when the child exits; `dispose` removes the temp dir.
 *
 * Ported from v1 `@agentick/sandbox-local/executor/darwin.ts`.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxStrategy } from "../platform/types.js";
import { compileSeatbeltProfile } from "../seatbelt/profile.js";
import type { CommandExecutor, SpawnOptions } from "./types.js";

export class DarwinExecutor implements CommandExecutor {
  readonly strategy: SandboxStrategy = "seatbelt";
  private readonly profileDir: string;

  constructor() {
    // Per-instance temp dir for profile files.
    this.profileDir = join(tmpdir(), `agentick-seatbelt-${randomBytes(6).toString("hex")}`);
    mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
  }

  spawn(command: string, options: SpawnOptions): ChildProcess {
    const profile = compileSeatbeltProfile(options);

    const profilePath = join(this.profileDir, `profile-${randomBytes(4).toString("hex")}.sb`);
    writeFileSync(profilePath, profile, { mode: 0o600 });

    const child = spawn("sandbox-exec", ["-f", profilePath, "/bin/bash", "-c", command], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group → the handle can kill the whole tree
    });

    // Remove the profile once the process starts / exits (best-effort).
    child.on("exit", () => {
      try {
        unlinkSync(profilePath);
      } catch {
        // Best-effort cleanup.
      }
    });

    return child;
  }

  dispose(): void {
    try {
      rmSync(this.profileDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}
