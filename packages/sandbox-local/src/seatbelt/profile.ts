/**
 * macOS Seatbelt (SBPL) profile generation (ADR 59, #240).
 *
 * Compiles {@link SpawnOptions} into Apple Seatbelt Profile Language for
 * `sandbox-exec -f`. Security model: **safe by default**.
 *
 * SBPL resolves conflicting rules by specificity — a more specific filter
 * wins; at equal specificity, deny beats allow. That lets us layer:
 *
 *   1. `(allow file-read*)`                        — system reads (bash + dylibs)
 *   2. `(deny file-read* (subpath "/Users"))`      — deny user home dirs
 *   3. `(allow file-read* (subpath "{workspace}"))`— re-allow workspace
 *
 * Step 2 (subpath filter) is more specific than step 1 (unfiltered), so it
 * wins under `/Users`. Step 3 is more specific than step 2, so workspace
 * access survives even when the workspace lives under a denied prefix.
 *
 * This blocks sandboxed processes from reading SSH keys, credentials, browser
 * profiles, keychains — while letting system libraries load. Writes are always
 * tight: workspace, rw-mounts, /tmp, /dev only.
 *
 * Ported faithfully from v1 `@agentick/sandbox-local/seatbelt/profile.ts`.
 */

import { dirname, sep } from "node:path";
import type { SpawnOptions } from "../executor/types.js";

/**
 * Paths sandboxed processes cannot read.
 *
 * /Users                  — home dirs (SSH keys, .env, browser profiles, creds)
 * /private/var/root       — root's home
 * /Volumes                — mounted / encrypted / network drives
 * /Network                — network-mounted resources
 * /Library/Keychains      — system keychains + certificates
 * /private/var/db/dslocal — local directory service (accounts, password hashes)
 */
const DENIED_READ_PATHS = [
  "/Users",
  "/private/var/root",
  "/Volumes",
  "/Network",
  "/Library/Keychains",
  "/private/var/db/dslocal",
];

/** Every directory above `path`, root excluded (`file-read*` already covers it). */
function ancestorsOf(path: string): string[] {
  const found: string[] = [];
  for (let at = dirname(path); at !== sep && at !== dirname(at); at = dirname(at)) found.push(at);
  return found;
}

/** Compile a seatbelt profile string from spawn options. */
export function compileSeatbeltProfile(options: SpawnOptions): string {
  const lines: string[] = [];

  const emit = (line: string): number => lines.push(line);
  const comment = (text: string): number => emit(`\n;; ${text}`);
  const allow = (...parts: string[]): number => emit(`(allow ${parts.join(" ")})`);
  const deny = (...parts: string[]): number => emit(`(deny ${parts.join(" ")})`);
  const subpath = (p: string): string => `(subpath "${p}")`;

  emit("(version 1)");
  deny("default");

  // Process execution
  comment("Process execution");
  allow("process*");
  allow("signal");
  allow("sysctl*");

  // File reads — allow system, deny sensitive, re-allow workspace/mounts.
  comment("File reads — safe by default");
  allow("file-read*");

  comment("Deny reads to sensitive paths (home dirs, volumes, keychains, etc.)");
  for (const p of DENIED_READ_PATHS) {
    deny("file-read*", subpath(p));
  }

  comment("Re-allow workspace reads");
  allow("file-read*", subpath(options.workspacePath));

  if (options.mounts.length > 0) {
    comment("Re-allow mount reads");
    for (const mount of options.mounts) {
      allow("file-read*", subpath(mount.hostPath));
    }
  }

  // A subpath allow reaches the contents but not the directories ABOVE it, so
  // a granted path under a denied prefix is openable yet un-`realpath`-able —
  // and node resolves its entry script through `realpath` before running it.
  // Metadata only: `lstat` passes, the denied directories stay unlistable.
  const granted = [options.workspacePath, ...options.mounts.map((m) => m.hostPath)];
  const ancestors = new Set(granted.flatMap(ancestorsOf));
  if (ancestors.size > 0) {
    comment("Traverse into granted paths (lstat only) — realpath walks every component");
    for (const ancestor of ancestors) {
      allow("file-read-metadata", `(literal "${ancestor}")`);
    }
  }

  // File writes — restricted to workspace, rw-mounts, and temp
  comment("File writes (restricted)");
  allow("file-write*", subpath(options.workspacePath));
  allow("file-write*", subpath("/private/tmp"));
  allow("file-write*", subpath("/tmp"));
  allow("file-write*", subpath("/dev"));

  if (options.mounts.length > 0) {
    comment("Mount writes (read-write mounts only)");
    for (const mount of options.mounts) {
      if (!mount.readOnly) {
        allow("file-write*", subpath(mount.hostPath));
      }
    }
  }

  // Network
  comment("Network");
  if (options.network === false) {
    deny("network*");
    // AF_UNIX carve-out (#274): a filesystem socket under the workspace is
    // supervised IPC, not egress. The subpath filter outranks the blanket deny
    // (specificity, header note) and cannot match an inet destination, so the
    // deny stays total for the network.
    comment("AF_UNIX under workspace + mounts stays open (supervised IPC)");
    allow("network-outbound", subpath(options.workspacePath));
    allow("network-bind", subpath(options.workspacePath));
    for (const mount of options.mounts) {
      allow("network-outbound", subpath(mount.hostPath));
    }
  } else {
    // `true` or NetworkRule[] — allow at the seatbelt level. Per-domain
    // NetworkRule enforcement happens in the proxy layer, not seatbelt.
    allow("network*");
  }

  return lines.join("\n") + "\n";
}
