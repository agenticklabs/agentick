/**
 * Command-executor contract — the STRATEGY interface (ADR 59, #240).
 *
 * A {@link CommandExecutor} knows how to wrap one argv in a particular
 * OS-isolation mechanism (seatbelt / bwrap / unshare / none). It returns the
 * argv to spawn and never touches the child: the handle owns the process
 * lifecycle (stdio, streaming, timeout/abort, process-group kill), which is
 * what lets the same jail carry both a fire-and-collect `exec` and a
 * long-lived `spawn` with a control channel. `selectExecutor` (chain of
 * strategies) picks the concrete executor from the detected
 * {@link SandboxStrategy}.
 *
 * Ported from v1 `@agentick/sandbox-local/executor/types.ts`, retyped against
 * the v2 layout: `ResolvedMount` is the single workspace-layer type (no v1
 * `mode` duplicate), and network policy is the spec `NetworkRule[]` (v1's
 * unused `ResolvedPermissions` read/write/childProcess fields are dropped —
 * the file API, not the jail, enforces path confinement).
 */

import type { NetworkRule } from "@agentick/sandbox";
import type { SandboxStrategy } from "../platform/types.js";
import type { ResolvedMount } from "../workspace.js";

/** An argv the caller can hand straight to `child_process.spawn`. */
export interface JailedCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Absent when the jail sets the working directory itself (bwrap `--chdir`). */
  readonly cwd?: string;
  /** Release per-invocation jail resources — call once the child has exited. */
  readonly release?: () => void;
}

export interface CommandExecutor {
  /** The isolation tier this executor implements. */
  readonly strategy: SandboxStrategy;
  /**
   * The shell that exists INSIDE this jail, as an argv prefix. bwrap builds
   * its own filesystem, so which shells are present is the jail's property.
   */
  readonly shell: readonly [string, ...string[]];
  /** Wrap a program invocation in the jail described by {@link SpawnOptions}. */
  wrap(command: string, args: readonly string[], options: SpawnOptions): JailedCommand;
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
