/**
 * `@agentick/utils-next/path/node` — realpath-descendant path confinement.
 *
 * Separate `/node` subpath because it imports `node:fs` (mirrors
 * `loaders/node`); keeping it out of the main entry preserves
 * browser/edge usage.
 *
 * The security property this closes: string-prefix containment over a
 * *lexically* resolved path is unsafe. A symlink INSIDE the root that
 * points outside — `<root>/link → /etc`, then read `<root>/link/passwd`
 * — sails through an `abs.startsWith(root + sep)` check while actually
 * touching `/etc/passwd`. Resolving symlinks with `realpath` BEFORE the
 * containment check closes the hole. Callers MUST pass an already
 * realpath-resolved `root` (resolve it once at construction — realpath
 * is a syscall; on macOS it also collapses `/var → /private/var`, so an
 * un-realpath'd root would spuriously fail containment).
 */

import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";

/**
 * Pure lexical containment: is `child` the `root` itself, or nested
 * beneath it? The `sep` suffix guards a sibling-prefix false match
 * (`/data-other` is NOT within `/data`). Both paths must already be
 * absolute + normalized — and, for a symlink-safe verdict, realpath'd.
 */
export function isPathWithin(child: string, root: string): boolean {
  return child === root || child.startsWith(root + sep);
}

/**
 * `realpath(absolute)`, tolerant of a not-yet-existing target.
 *
 * `realpath` throws `ENOENT` on a missing leaf, so we resolve the
 * deepest EXISTING ancestor's realpath (following any symlinks along the
 * real portion) and re-append the missing suffix lexically. This is the
 * correct handling for two cases:
 *
 *   - a create/write whose parent dirs don't exist yet, and
 *   - a read of an absent file, where the containment verdict must still
 *     hold: `<root>/link` exists and points to `/etc`, so target
 *     `<root>/link/passwd` resolves to `/etc/passwd` and fails
 *     containment even though `passwd` was never stat-able.
 *
 * `absolute` must be an absolute path.
 */
export async function realpathAllowingMissing(absolute: string): Promise<string> {
  try {
    return await realpath(absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  // Walk up to the closest existing ancestor, accumulating the missing
  // suffix, then splice the ancestor's realpath back onto it.
  let ancestor = resolve(absolute);
  let suffix = "";
  for (;;) {
    const parent = dirname(ancestor);
    suffix = ancestor.slice(parent.length) + suffix;
    if (parent === ancestor) return resolve(absolute); // hit the root; nothing exists
    ancestor = parent;
    try {
      return (await realpath(ancestor)) + suffix;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

/**
 * Resolve `inputPath` (relative to `root` when not absolute), follow
 * symlinks via {@link realpathAllowingMissing}, and confirm the result
 * is contained within `root`. Returns the realpath-resolved absolute
 * path when contained, else `null`.
 *
 * `root` MUST already be realpath-resolved by the caller.
 */
export async function realpathWithin(inputPath: string, root: string): Promise<string | null> {
  const absolute = isAbsolute(inputPath) ? inputPath : resolve(root, inputPath);
  const resolved = await realpathAllowingMissing(absolute);
  return isPathWithin(resolved, root) ? resolved : null;
}
