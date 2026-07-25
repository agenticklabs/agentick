/**
 * Path safety — resolve a caller-supplied path, follow symlinks, and
 * confine it to the workspace root or an allowed mount. Rejects null
 * bytes, `..` traversal, and symlink escapes with {@link SandboxEscapeError}.
 *
 * Ported from v1 `@agentick/sandbox-local/paths.ts`, retyped against the
 * v2 spec (`SandboxEscapeError`, `readOnly` mounts).
 */

import { resolve, isAbsolute } from "node:path";
import { SandboxEscapeError } from "@agentick/sandbox";
import { isPathWithin, realpathAllowingMissing } from "@agentick/utils/path/node";
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

  // Follow symlinks before the containment check. A missing target (its
  // leaf, or parent dirs on a create) is bounded by the deepest existing
  // ancestor's realpath — see `realpathAllowingMissing` — so a symlink
  // escape in the real prefix is still caught even when the leaf is absent.
  const resolved = await realpathAllowingMissing(absolute);

  if (isPathWithin(resolved, realWorkspace)) return resolved;

  for (const mount of mounts) {
    if (isPathWithin(resolved, mount.hostPath)) {
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

/** Strip loader-hijack env vars from a record before spawning. */
export function filterEnv(env: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_BLOCKLIST.has(key)) filtered[key] = value;
  }
  return filtered;
}
