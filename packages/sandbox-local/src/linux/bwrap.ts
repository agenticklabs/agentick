/**
 * Bubblewrap argument builder.
 *
 * Constructs the bwrap command-line arguments from SpawnOptions.
 */

import type { SpawnOptions } from "../executor/types";

/** System directories to mount read-only into the sandbox. */
const SYSTEM_RO_BINDS = ["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc"];

/**
 * Build bubblewrap argument array for a given set of spawn options.
 */
export function buildBwrapArgs(options: SpawnOptions): string[] {
  const args: string[] = [];

  // Namespace isolation
  args.push("--unshare-all");

  // Re-share network if allowed
  const net = options.permissions.network;
  if (net === true || (Array.isArray(net) && net.length > 0)) {
    args.push("--share-net");
  }

  // System directories (read-only)
  for (const dir of SYSTEM_RO_BINDS) {
    args.push("--ro-bind", dir, dir);
  }

  // Proc, dev, tmp
  args.push("--proc", "/proc");
  args.push("--dev", "/dev");
  args.push("--tmpfs", "/tmp");

  // Workspace (read-write)
  args.push("--bind", options.workspacePath, options.workspacePath);

  // User mounts
  for (const mount of options.mounts) {
    if (mount.mode === "ro") {
      args.push("--ro-bind", mount.hostPath, mount.sandboxPath);
    } else {
      args.push("--bind", mount.hostPath, mount.sandboxPath);
    }
  }

  // Safety
  args.push("--die-with-parent");
  args.push("--new-session");

  // Working directory
  args.push("--chdir", options.cwd);

  return args;
}
