/**
 * macOS Seatbelt Executor
 *
 * Generates a seatbelt profile from SpawnOptions, writes it to a temp file,
 * and spawns the command under sandbox-exec.
 */

import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";
import type { CommandExecutor, SpawnOptions } from "./types";
import type { SandboxStrategy } from "../platform/types";
import { compileSeatbeltProfile } from "../seatbelt/profile";

export class DarwinExecutor implements CommandExecutor {
  readonly strategy: SandboxStrategy = "seatbelt";
  private readonly profileDir: string;

  constructor() {
    // Per-instance temp dir for profile files
    this.profileDir = join(tmpdir(), `agentick-seatbelt-${randomBytes(6).toString("hex")}`);
    mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
  }

  spawn(command: string, options: SpawnOptions): ChildProcess {
    const profile = compileSeatbeltProfile(options);

    // Write profile to temp file with restricted permissions
    const profilePath = join(this.profileDir, `profile-${randomBytes(4).toString("hex")}.sb`);
    writeFileSync(profilePath, profile, { mode: 0o600 });

    const child = spawn("sandbox-exec", ["-f", profilePath, "/bin/bash", "-c", command], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    // Clean up profile after process starts
    child.on("exit", () => {
      try {
        unlinkSync(profilePath);
      } catch {
        // Best-effort cleanup
      }
    });

    return child;
  }
}
