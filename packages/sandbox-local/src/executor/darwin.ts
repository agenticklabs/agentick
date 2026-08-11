/**
 * macOS seatbelt executor — strategy `"seatbelt"` (ADR 59, #240).
 *
 * Compiles a per-invocation SBPL profile from {@link SpawnOptions}, writes it
 * to a per-instance temp dir (mode 0700, profile files 0600), and prefixes the
 * argv with `sandbox-exec -f <profile>`. `sandbox-exec` applies the profile and
 * then EXECS the program, so the child keeps its pid and every inherited file
 * descriptor — which is what lets a supervised process keep its control
 * channel across the jail boundary. `release` removes the profile; `dispose`
 * removes the temp dir.
 *
 * Ported from v1 `@agentick/sandbox-local/executor/darwin.ts`.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxStrategy } from "../platform/types.js";
import { compileSeatbeltProfile } from "../seatbelt/profile.js";
import type { CommandExecutor, JailedCommand, SpawnOptions } from "./types.js";

export class DarwinExecutor implements CommandExecutor {
  readonly strategy: SandboxStrategy = "seatbelt";
  readonly shell = ["/bin/bash", "-c"] as const;
  private readonly profileDir: string;

  constructor() {
    // Per-instance temp dir for profile files.
    this.profileDir = join(tmpdir(), `agentick-seatbelt-${randomBytes(6).toString("hex")}`);
    mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
  }

  wrap(command: string, args: readonly string[], options: SpawnOptions): JailedCommand {
    const profilePath = join(this.profileDir, `profile-${randomBytes(4).toString("hex")}.sb`);
    writeFileSync(profilePath, compileSeatbeltProfile(options), { mode: 0o600 });

    return {
      command: "sandbox-exec",
      args: ["-f", profilePath, command, ...args],
      cwd: options.cwd,
      release: () => {
        try {
          unlinkSync(profilePath);
        } catch {
          // Best-effort cleanup.
        }
      },
    };
  }

  dispose(): void {
    try {
      rmSync(this.profileDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}
