/**
 * Configuration types for the secure-exec sandbox provider.
 */

import type { VirtualFileSystem } from "secure-exec";

export interface SecureExecProviderConfig {
  /** Isolate memory limit in MB. Default: 128. */
  memoryLimit?: number;

  /** CPU time budget per exec() call in milliseconds. Default: 30_000. */
  cpuTimeLimitMs?: number;

  /** Workspace root path inside the VFS. Default: "/workspace". */
  workspacePath?: string;

  /**
   * Host directory from which to resolve node_modules for require/import.
   * Set to `false` to disable module access entirely.
   * Default: process.cwd().
   */
  moduleAccess?: string | false;

  /** Enable network access (fetch, HTTP) inside the isolate. Default: false. */
  network?: boolean;

  /** Optional persistence adapter for saving/restoring VFS state. */
  persistence?: PersistenceAdapter;

  /**
   * Timing side-channel mitigation.
   * - "freeze" — Date.now() and performance.now() return static values (default)
   * - "off" — real timers, needed for code that uses timeouts/intervals
   */
  timingMitigation?: "off" | "freeze";
}

export interface PersistenceAdapter {
  /** Load persisted VFS state into the given filesystem. */
  load(sandboxId: string, vfs: VirtualFileSystem): Promise<void>;

  /** Save the current VFS state for later restoration. */
  save(sandboxId: string, vfs: VirtualFileSystem): Promise<void>;
}
