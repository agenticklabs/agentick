/**
 * Sandbox Access Error
 *
 * Thrown when a file operation targets a path outside the sandbox workspace
 * and allowed mounts. Carries metadata for upstream recovery (confirmation
 * prompt → mount/allow → retry).
 */

export class SandboxAccessError extends Error {
  readonly name = "SandboxAccessError";

  constructor(
    readonly requestedPath: string,
    readonly resolvedPath: string,
    readonly mode: "read" | "write",
  ) {
    super(`Path escapes sandbox: ${requestedPath} → ${resolvedPath}`);
  }

  /**
   * Attached by the sandbox implementation after catching.
   * Adds a mount for the parent directory of the resolved path.
   * Returns a cleanup function if the allow is temporary (!always).
   */
  recover?: (always: boolean) => Promise<(() => void) | void>;
}
