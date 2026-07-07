/**
 * Bubblewrap argument builder (ADR 59, #240).
 *
 * Constructs the `bwrap` command line from {@link SpawnOptions}:
 * `--unshare-all` (all namespaces), read-only system binds, a private
 * `/proc` + `/dev` + tmpfs `/tmp`, a read-write workspace bind, user mounts
 * (`--ro-bind` / `--bind` per `readOnly`), `--die-with-parent`, and a fresh
 * session. Network is re-shared only when egress is allowed.
 *
 * Ported from v1 `@agentick/sandbox-local/linux/bwrap.ts`, retyped to the v2
 * `ResolvedMount` (`readOnly` flag; no `mode`).
 */

import type { SpawnOptions } from "../executor/types.js";

/** System directories mounted read-only into the sandbox. */
const SYSTEM_RO_BINDS = ["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc"];

/** Build the bubblewrap argument array for a set of spawn options. */
export function buildBwrapArgs(options: SpawnOptions): string[] {
  const args: string[] = [];

  // Namespace isolation.
  args.push("--unshare-all");

  // Re-share network only if egress is allowed (true or a non-empty rule list).
  const net = options.network;
  if (net === true || (Array.isArray(net) && net.length > 0)) {
    args.push("--share-net");
  }

  // System directories (read-only).
  for (const dir of SYSTEM_RO_BINDS) {
    args.push("--ro-bind", dir, dir);
  }

  // Proc, dev, tmp.
  args.push("--proc", "/proc");
  args.push("--dev", "/dev");
  args.push("--tmpfs", "/tmp");

  // Workspace (read-write).
  args.push("--bind", options.workspacePath, options.workspacePath);

  // User mounts.
  for (const mount of options.mounts) {
    if (mount.readOnly) {
      args.push("--ro-bind", mount.hostPath, mount.sandboxPath);
    } else {
      args.push("--bind", mount.hostPath, mount.sandboxPath);
    }
  }

  // Safety.
  args.push("--die-with-parent");
  args.push("--new-session");

  // Working directory.
  args.push("--chdir", options.cwd);

  return args;
}
