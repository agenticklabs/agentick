/**
 * `unshare` argument builder (ADR 59, #240).
 *
 * Lighter isolation than bubblewrap — Linux namespaces directly: mount + PID
 * (with `--fork`), a network namespace ONLY when egress is denied (so the
 * process gets a loopback-only, route-less namespace), and a user namespace
 * with root-mapping for privilege isolation. The fallback jail when `bwrap`
 * is absent but `unshare` + unprivileged user namespaces exist.
 *
 * Ported from v1 `@agentick/sandbox-local/linux/unshare.ts`.
 */

import type { SpawnOptions } from "../executor/types.js";

/** Build the `unshare` argument array for a set of spawn options. */
export function buildUnshareArgs(options: SpawnOptions): string[] {
  const args: string[] = [];

  // PID and mount namespaces.
  args.push("--mount", "--pid", "--fork");

  // Network namespace only when egress is denied (isolates the process from
  // the host network stack — no routes, loopback only).
  if (options.network === false) {
    args.push("--net");
  }

  // User namespace for privilege isolation.
  args.push("--user", "--map-root-user");

  return args;
}
