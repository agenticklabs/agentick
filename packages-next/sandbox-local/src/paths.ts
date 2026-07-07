/**
 * Path safety — resolve a caller-supplied path, follow symlinks, and
 * confine it to the workspace root or an allowed mount. Rejects null
 * bytes, `..` traversal, and symlink escapes with {@link SandboxEscapeError}.
 *
 * Ported from v1 `@agentick/sandbox-local/paths.ts`, retyped against the
 * v2 spec (`SandboxEscapeError`, `readOnly` mounts).
 */

import { realpath } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { SandboxEscapeError } from "@agentick/sandbox-next";
import type { ResolvedMount } from "./workspace.js";

/** Environment variables that must never be inherited (loader hijacks). */
export const ENV_BLOCKLIST: ReadonlySet<string> = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
]);

/**
 * Resolve and validate that a path is within the workspace or an allowed
 * mount. `workspacePath` and mount `hostPath`s MUST already be
 * realpath-resolved (done once at creation) so this avoids redundant
 * realpath calls on every op.
 *
 * @throws SandboxEscapeError on null bytes, traversal, or out-of-bounds
 * @throws SandboxEscapeError (`mount-escape`) on write to a read-only mount
 */
export async function resolveSafePath(
  inputPath: string,
  workspacePath: string,
  mode: "read" | "write",
  mounts: readonly ResolvedMount[] = [],
): Promise<string> {
  if (inputPath.includes("\0")) {
    throw new SandboxEscapeError({
      kind: "path-traversal",
      target: inputPath,
      detail: "null byte",
    });
  }

  const realWorkspace = workspacePath;
  const absolute = isAbsolute(inputPath) ? inputPath : resolve(realWorkspace, inputPath);

  let resolved: string;
  try {
    resolved = await realpath(absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (mode === "write") {
        // Target (or parent dirs) don't exist yet — walk up to the
        // closest existing ancestor, then re-attach the missing suffix.
        resolved = await resolveNonExistentPath(absolute, inputPath);
      } else {
        // Reads of a missing file: normalize and bounds-check by path
        // manipulation (catches traversal even when the target is absent).
        resolved = resolve(absolute);
        if (isWithin(resolved, realWorkspace) || inAnyMount(resolved, mounts)) return resolved;
        throw new SandboxEscapeError({ kind: "path-traversal", target: inputPath });
      }
    } else {
      throw err;
    }
  }

  if (isWithin(resolved, realWorkspace)) return resolved;

  for (const mount of mounts) {
    if (resolved === mount.hostPath || resolved.startsWith(mount.hostPath + "/")) {
      if (mode === "write" && mount.readOnly) {
        throw new SandboxEscapeError({
          kind: "mount-escape",
          target: inputPath,
          detail: `resolves to read-only mount ${mount.sandboxPath}`,
        });
      }
      return resolved;
    }
  }

  throw new SandboxEscapeError({ kind: "path-traversal", target: inputPath });
}

function isWithin(resolved: string, root: string): boolean {
  return resolved === root || resolved.startsWith(root + "/");
}

function inAnyMount(resolved: string, mounts: readonly ResolvedMount[]): boolean {
  return mounts.some((m) => resolved === m.hostPath || resolved.startsWith(m.hostPath + "/"));
}

/**
 * Walk up to the closest existing ancestor (realpath-resolved), then
 * re-append the not-yet-existing suffix. Used for write-mode targets
 * whose parent directories may not exist yet.
 */
async function resolveNonExistentPath(absolute: string, inputPath: string): Promise<string> {
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
      // keep walking up
    }
  }
  throw new SandboxEscapeError({
    kind: "path-traversal",
    target: inputPath,
    detail: "no accessible ancestor",
  });
}

/** Strip loader-hijack env vars from a record before spawning. */
export function filterEnv(env: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_BLOCKLIST.has(key)) filtered[key] = value;
  }
  return filtered;
}
