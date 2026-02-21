/**
 * macOS Seatbelt Profile Generation
 *
 * Compiles SpawnOptions into Apple Seatbelt Profile Language (SBPL).
 *
 * Security model: "safe by default"
 *
 * SBPL resolves conflicting rules by specificity — more specific wins.
 * At equal specificity, deny beats allow. This lets us:
 *
 *   1. (allow file-read*)                         — system reads (needed for bash)
 *   2. (deny file-read* (subpath "/Users"))        — deny user home dirs
 *   3. (allow file-read* (subpath "{workspace}"))  — re-allow workspace
 *
 * The deny at step 2 is more specific than the allow at step 1, so it wins
 * for paths under /Users. The allow at step 3 is more specific than the deny
 * at step 2, so workspace access works even if it's under /Users.
 *
 * This prevents sandboxed processes from reading SSH keys, credentials,
 * browser profiles, and other sensitive user data — while still allowing
 * system libraries and executables to load normally.
 *
 * Write restrictions are always tight: only workspace, mounts, /tmp, /dev.
 */

import type { SpawnOptions } from "../executor/types.js";

/**
 * Paths that sandboxed processes cannot read.
 *
 * /Users               — home directories (SSH keys, .env, browser profiles, credentials)
 * /private/var/root    — root's home directory
 * /Volumes             — mounted drives, encrypted volumes, network shares
 * /Network             — network-mounted resources
 * /Library/Keychains   — system-level keychains and certificates
 * /private/var/db/dslocal — local directory service (user account data, password hashes)
 */
const DENIED_READ_PATHS = [
  "/Users",
  "/private/var/root",
  "/Volumes",
  "/Network",
  "/Library/Keychains",
  "/private/var/db/dslocal",
];

/**
 * Compile a seatbelt profile string from spawn options.
 */
export function compileSeatbeltProfile(options: SpawnOptions): string {
  const lines: string[] = [];

  const emit = (line: string) => lines.push(line);
  const comment = (text: string) => emit(`\n;; ${text}`);
  const allow = (...parts: string[]) => emit(`(allow ${parts.join(" ")})`);
  const deny = (...parts: string[]) => emit(`(deny ${parts.join(" ")})`);
  const subpath = (p: string) => `(subpath "${p}")`;

  emit("(version 1)");
  deny("default");

  // Process execution
  comment("Process execution");
  allow("process*");
  allow("signal");
  allow("sysctl*");

  // File reads — allow system, deny sensitive, re-allow workspace/mounts.
  // SBPL specificity: subpath filter > unfiltered, so deny(subpath) > allow(*).
  comment("File reads — safe by default");
  allow("file-read*");

  comment("Deny reads to sensitive paths (home dirs, volumes, keychains, etc.)");
  for (const p of DENIED_READ_PATHS) {
    deny("file-read*", subpath(p));
  }

  // Re-allow workspace reads (more specific than /Users deny)
  comment("Re-allow workspace reads");
  allow("file-read*", subpath(options.workspacePath));

  // Re-allow mount reads
  if (options.mounts.length > 0) {
    comment("Re-allow mount reads");
    for (const mount of options.mounts) {
      allow("file-read*", subpath(mount.hostPath));
    }
  }

  // File writes — restricted to workspace, mounts, and temp
  comment("File writes (restricted)");
  allow("file-write*", subpath(options.workspacePath));
  allow("file-write*", subpath("/private/tmp"));
  allow("file-write*", subpath("/tmp"));
  allow("file-write*", subpath("/dev"));

  // Mount writes
  if (options.mounts.length > 0) {
    comment("Mount writes");
    for (const mount of options.mounts) {
      if (mount.mode === "rw") {
        allow("file-write*", subpath(mount.hostPath));
      }
    }
  }

  // Network
  comment("Network");
  const net = options.permissions.network;
  if (net === false) {
    deny("network*");
  } else {
    // net === true or NetworkRule[] — allow all at seatbelt level.
    // NetworkRule enforcement happens via the proxy layer, not seatbelt.
    allow("network*");
  }

  return lines.join("\n") + "\n";
}
