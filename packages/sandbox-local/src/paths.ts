/**
 * Path Safety
 *
 * Resolves paths, follows symlinks, validates bounds against workspace and mounts.
 * Rejects path traversal, null bytes, and escape attempts.
 */

import { realpath } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { SandboxAccessError } from "@agentick/sandbox";
import type { ResolvedMount } from "./executor/types";

/** Environment variables that must never be inherited. */
export const ENV_BLOCKLIST = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
]);

/**
 * Resolve and validate a path is within the workspace or an allowed mount.
 *
 * IMPORTANT: workspacePath must already be realpath-resolved (done once at
 * creation time by createWorkspace). Mount hostPaths are also pre-resolved
 * by resolveMounts. This avoids redundant realpath calls on every file op.
 *
 * @param inputPath - The path to resolve (relative to workspace or absolute)
 * @param workspacePath - The sandbox workspace root (must be pre-resolved via realpath)
 * @param mode - Required access mode ("read" or "write")
 * @param mounts - Resolved mounts with host paths and modes
 * @returns The resolved absolute path
 * @throws On null bytes, traversal, or out-of-bounds access
 */
export async function resolveSafePath(
  inputPath: string,
  workspacePath: string,
  mode: "read" | "write",
  mounts: ResolvedMount[] = [],
): Promise<string> {
  // Reject null bytes
  if (inputPath.includes("\0")) {
    throw new Error("Path contains null bytes");
  }

  // workspacePath is pre-resolved via realpath by createWorkspace()
  const realWorkspace = workspacePath;

  // Resolve to absolute (relative paths are relative to workspace)
  const absolute = isAbsolute(inputPath) ? inputPath : resolve(realWorkspace, inputPath);

  // Try to follow symlinks to the real path. If the file doesn't exist yet
  // (write mode), resolve the parent directory instead.
  let resolved: string;
  try {
    resolved = await realpath(absolute);
  } catch (err: any) {
    if (err.code === "ENOENT") {
      if (mode === "write") {
        // File (or parent dirs) don't exist yet — walk up to find the
        // closest existing ancestor, then verify it's within bounds
        resolved = await resolveNonExistentPath(absolute);
      } else {
        // For reads, if the file doesn't exist, resolve what we can and
        // check bounds using path manipulation (to catch traversal attempts
        // even when target doesn't exist)
        resolved = resolve(absolute);
        // Normalize out .. components
        if (!resolved.startsWith(realWorkspace + "/") && resolved !== realWorkspace) {
          // Check mounts (hostPaths are pre-resolved by resolveMounts)
          let inMount = false;
          for (const mount of mounts) {
            if (resolved === mount.hostPath || resolved.startsWith(mount.hostPath + "/")) {
              inMount = true;
              break;
            }
          }
          if (!inMount) {
            throw new SandboxAccessError(inputPath, resolved, mode);
          }
        }
        return resolved;
      }
    } else {
      throw err;
    }
  }

  // Check workspace bounds
  if (resolved === realWorkspace || resolved.startsWith(realWorkspace + "/")) {
    return resolved;
  }

  // Check mounts (hostPaths are pre-resolved by resolveMounts)
  for (const mount of mounts) {
    const inMount = resolved === mount.hostPath || resolved.startsWith(mount.hostPath + "/");
    if (inMount) {
      if (mode === "write" && mount.mode === "ro") {
        throw new Error(
          `Write access denied: ${inputPath} resolves to read-only mount ${mount.sandboxPath}`,
        );
      }
      return resolved;
    }
  }

  throw new SandboxAccessError(inputPath, resolved, mode);
}

/**
 * Walk up the path tree to find the closest existing ancestor,
 * then append the remaining segments. Used for write mode when
 * the target file (and potentially parent dirs) don't exist yet.
 */
async function resolveNonExistentPath(absolute: string): Promise<string> {
  let ancestor = absolute;
  let suffix = "";
  while (ancestor !== "/" && ancestor !== ".") {
    const parent = resolve(ancestor, "..");
    suffix = ancestor.slice(parent.length) + suffix;
    ancestor = parent;
    try {
      const resolvedAncestor = await realpath(ancestor);
      return resolvedAncestor + suffix;
    } catch {
      // Keep walking up
    }
  }
  throw new Error(`No accessible ancestor for path: ${absolute}`);
}

/**
 * Filter dangerous environment variables from an env record.
 */
export function filterEnv(env: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_BLOCKLIST.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}
