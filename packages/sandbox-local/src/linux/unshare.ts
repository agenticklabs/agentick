/**
 * unshare argument builder.
 *
 * Lighter isolation than bubblewrap — uses Linux namespaces directly.
 */

import type { SpawnOptions } from "../executor/types";

/**
 * Build unshare argument array for a given set of spawn options.
 */
export function buildUnshareArgs(options: SpawnOptions): string[] {
  const args: string[] = [];

  // PID and mount namespaces
  args.push("--mount", "--pid", "--fork");

  // Network namespace (only if network denied)
  const net = options.permissions.network;
  if (net === false) {
    args.push("--net");
  }

  // User namespace for privilege isolation
  args.push("--user", "--map-root-user");

  return args;
}
