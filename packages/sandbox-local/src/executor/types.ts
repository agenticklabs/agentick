/**
 * Command executor types.
 */

import type { ChildProcess } from "node:child_process";
import type { SandboxStrategy } from "../platform/types";
import type { NetworkRule } from "@agentick/sandbox";

export interface CommandExecutor {
  readonly strategy: SandboxStrategy;
  spawn(command: string, options: SpawnOptions): ChildProcess;
}

export interface SpawnOptions {
  cwd: string;
  env: Record<string, string>;
  workspacePath: string;
  mounts: ResolvedMount[];
  permissions: ResolvedPermissions;
}

export interface ResolvedPermissions {
  readPaths: string[];
  writePaths: string[];
  network: boolean | NetworkRule[];
  childProcess: boolean;
}

export interface ResolvedMount {
  hostPath: string;
  sandboxPath: string;
  mode: "ro" | "rw";
}
