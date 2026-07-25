/**
 * Command-executor contract — the STRATEGY interface (ADR 59, #240).
 *
 * A {@link CommandExecutor} knows how to spawn one shell command under a
 * particular OS-isolation mechanism (seatbelt / bwrap / unshare / none). The
 * handle owns the process lifecycle (stdout/stderr streaming, timeout/abort,
 * process-group kill); the executor owns ONLY the jail wrapping. `selectExecutor`
 * (chain of strategies) picks the concrete executor from the detected
 * {@link SandboxStrategy}.
 *
 * Ported from v1 `@agentick/sandbox-local/executor/types.ts`, retyped against
 * the v2 layout: `ResolvedMount` is the single workspace-layer type (no v1
 * `mode` duplicate), and network policy is the spec `NetworkRule[]` (v1's
 * unused `ResolvedPermissions` read/write/childProcess fields are dropped —
 * the file API, not the jail, enforces path confinement).
 */

import type { ChildProcess } from "node:child_process";
import type { NetworkRule } from "@agentick/sandbox";
import type { SandboxStrategy } from "../platform/types.js";
import type { ResolvedMount } from "../workspace.js";

export interface CommandExecutor {
  /** The isolation tier this executor implements. */
  readonly strategy: SandboxStrategy;
  /** Spawn `command` jailed per {@link SpawnOptions}; returns the child. */
  spawn(command: string, options: SpawnOptions): ChildProcess;
  /** Release executor-scoped resources (e.g. seatbelt profile temp dir). */
  dispose?(): void;
}

export interface SpawnOptions {
  /** Working directory (already workspace-confined by the handle). */
  readonly cwd: string;
  /** Environment (already `filterEnv`-scrubbed by the handle). */
  readonly env: Record<string, string>;
  /** Realpath-resolved workspace root — the jail's writable anchor. */
  readonly workspacePath: string;
  /** Resolved mounts — extend the jail's read/write allow-set. */
  readonly mounts: readonly ResolvedMount[];
  /**
   * Egress policy. `false` → jail-level network deny (seatbelt `deny
   * network*` / bwrap no `--share-net`). `true` / `NetworkRule[]` → jail
   * allows egress; per-domain rules are enforced by the proxy layer, not
   * the jail.
   */
  readonly network: boolean | readonly NetworkRule[];
}
