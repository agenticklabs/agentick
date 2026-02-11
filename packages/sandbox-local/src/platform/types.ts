/**
 * Platform detection types.
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
