/**
 * Sandbox protocol types — wire shapes for the sandbox abstraction.
 *
 * v1 lives in `@agentick/sandbox/types.ts`. v2 mirrors the shapes here
 * so any reconciler (React, Angular, Vue) can integrate sandboxes via
 * the `SandboxBridge` without depending on v1's component runtime.
 *
 * Provider adapters (`@agentick/sandbox-local`, `sandbox-docker`,
 * `sandbox-secure-exec`, …) implement {@link SandboxProvider}. Each
 * reconciler ships a framework-specific component (`<Sandbox>` in
 * React, `@Injectable()` SandboxService in Angular, etc.) that uses
 * the provider to create a {@link SandboxHandle} and registers it
 * with the session's {@link SandboxBridge}.
 *
 * @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md
 */

// ============================================================================
// Runtime handle
// ============================================================================

/**
 * Live sandbox instance. Created by a {@link SandboxProvider},
 * registered with the {@link SandboxBridge} by a framework-specific
 * component, queried by tools at dispatch time.
 *
 * Handles are NOT serializable — they hold provider-specific resources
 * (file descriptors, container ids, process handles). Hibernate-resume
 * recreates handles by replaying the provider create-call from the
 * snapshot's declared {@link SandboxIntent}.
 */
export interface SandboxHandle {
  /** Unique sandbox instance id within the session. */
  readonly id: string;
  /** Absolute path to the workspace root inside the sandbox. */
  readonly workspacePath: string;
  /** Execute a shell command. */
  exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult>;
  /** Read a file from the sandbox filesystem. */
  readFile(path: string): Promise<string>;
  /** Write a file to the sandbox filesystem. */
  writeFile(path: string, content: string): Promise<void>;
  /** Tear down the sandbox and release provider-side resources. */
  destroy(): Promise<void>;
}

export interface SandboxExecOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly stdin?: string;
}

export interface SandboxExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly signaled: boolean;
  readonly durationMs: number;
}

// ============================================================================
// Provider
// ============================================================================

export interface SandboxProvider {
  /** Provider name (e.g. "local", "docker", "e2b"). */
  readonly name: string;
  create(options: SandboxCreateOptions): Promise<SandboxHandle>;
  /**
   * Optional: restore a sandbox from a prior snapshot. Implementations
   * MAY no-op (or throw `SnapshotIncompatibleError`) when persistence
   * isn't supported — the bridge falls back to `create()`.
   */
  restore?(snapshot: SandboxSnapshot): Promise<SandboxHandle>;
}

export interface SandboxCreateOptions {
  /** Workspace path on the host. `true` = auto-allocate a temp dir. */
  readonly workspace?: string | true;
  /** Filesystem mounts (host ↔ sandbox path pairs). */
  readonly mounts?: readonly SandboxMount[];
  /** Advisory capability set (which syscalls / network the sandbox allows). */
  readonly allow?: SandboxPermissions;
  /** Environment variables. Resolved to strings before reaching the provider. */
  readonly env?: Readonly<Record<string, string>>;
  /** Resource constraints (memory, cpu, disk, time). */
  readonly limits?: SandboxResourceLimits;
}

export interface SandboxMount {
  readonly hostPath: string;
  readonly sandboxPath: string;
  readonly mode?: "ro" | "rw";
}

export interface SandboxPermissions {
  readonly network?: boolean;
  readonly fileSystem?: "none" | "workspace" | "host";
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface SandboxResourceLimits {
  readonly memoryMb?: number;
  readonly cpuPercent?: number;
  readonly diskMb?: number;
  readonly wallClockSec?: number;
}

// ============================================================================
// Snapshot / intent
// ============================================================================

/**
 * Declarative shape captured by the snapshot. The framework component
 * declared a `<Sandbox provider={p} ...>` mount; the bridge records the
 * intent so hibernate-resume can recreate the handle.
 */
export interface SandboxIntent {
  readonly id: string;
  readonly providerName: string;
  readonly options: SandboxCreateOptions;
  /** Optional provider-private snapshot blob for `provider.restore`. */
  readonly providerSnapshot?: SandboxSnapshot;
}

/**
 * Provider-specific snapshot blob. Opaque to the bridge; only the
 * provider that produced it can interpret it.
 */
export interface SandboxSnapshot {
  readonly providerName: string;
  readonly data: Readonly<Record<string, unknown>>;
}
