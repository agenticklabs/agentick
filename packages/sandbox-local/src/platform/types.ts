/**
 * Platform-detection types for the local jail (ADR 59, #240).
 *
 * `SandboxStrategy` is the effective isolation tier the provider selects
 * for `exec`; it is surfaced honestly on the handle (`LocalSandbox.isolation`)
 * so a caller can never mistake a passthrough (`"none"`) for a real jail.
 *
 * Ported from v1 `@agentick/sandbox-local/platform/types.ts`.
 */

/**
 * The OS-isolation mechanism used to jail `exec`:
 *   - `seatbelt` — macOS `sandbox-exec` with a compiled SBPL profile
 *   - `bwrap`    — Linux bubblewrap (namespaces + read-only system binds)
 *   - `unshare`  — Linux `unshare` (lighter namespace isolation)
 *   - `none`     — NO jail: a bare child process. The file API is still
 *     path-confined and egress still proxied, but `exec` is UNCONFINED.
 *     Surfaced loudly; never presented as confinement.
 */
export type SandboxStrategy = "seatbelt" | "bwrap" | "unshare" | "none";

export interface PlatformCapabilities {
  platform: "darwin" | "linux" | "win32" | "unknown";
  arch: string;

  // macOS
  hasSandboxExec: boolean;

  // Linux
  hasBwrap: boolean;
  hasUnshare: boolean;
  hasCgroupsV2: boolean;
  userNamespaces: boolean;

  // General
  uid: number;
  recommended: SandboxStrategy;
}
