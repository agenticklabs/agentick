/**
 * Platform capability detection.
 *
 * Probes the OS for sandbox features: macOS sandbox-exec, Linux bubblewrap/unshare,
 * cgroups v2, user namespaces. Result is cached after first call.
 */

import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { promisify } from "node:util";
import type { PlatformCapabilities, SandboxStrategy } from "./types";

const execFileAsync = promisify(execFile);

let cached: PlatformCapabilities | undefined;

/** Check if a binary exists on PATH. */
async function which(name: string): Promise<boolean> {
  try {
    await execFileAsync("which", [name]);
    return true;
  } catch {
    return false;
  }
}

/** Check if a file exists and is readable. */
async function readable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect platform sandbox capabilities.
 * Result is cached — safe to call multiple times.
 */
export async function detectCapabilities(): Promise<PlatformCapabilities> {
  if (cached) return cached;

  const rawPlatform = process.platform;
  const platform =
    rawPlatform === "darwin" || rawPlatform === "linux" || rawPlatform === "win32"
      ? rawPlatform
      : ("unknown" as const);

  const base: PlatformCapabilities = {
    platform,
    arch: process.arch,
    hasSandboxExec: false,
    hasBwrap: false,
    hasUnshare: false,
    hasCgroupsV2: false,
    userNamespaces: false,
    uid: process.getuid?.() ?? -1,
    recommended: "none",
  };

  if (platform === "darwin") {
    base.hasSandboxExec = await readable("/usr/bin/sandbox-exec");
    base.recommended = base.hasSandboxExec ? "seatbelt" : "none";
  } else if (platform === "linux") {
    const [hasBwrap, hasUnshare, hasCgroups, userNs] = await Promise.all([
      which("bwrap"),
      which("unshare"),
      readable("/sys/fs/cgroup/cgroup.controllers"),
      readFile("/proc/sys/kernel/unprivileged_userns_clone", "utf-8")
        .then((v) => v.trim() === "1")
        .catch(() => false),
    ]);
    base.hasBwrap = hasBwrap;
    base.hasUnshare = hasUnshare;
    base.hasCgroupsV2 = hasCgroups;
    base.userNamespaces = userNs;

    if (hasBwrap) base.recommended = "bwrap";
    else if (hasUnshare && userNs) base.recommended = "unshare";
    else base.recommended = "none";
  }

  cached = base;
  return base;
}

/** Select the best strategy given capabilities and optional override. */
export function selectStrategy(
  caps: PlatformCapabilities,
  override?: SandboxStrategy | "auto",
): SandboxStrategy {
  if (!override || override === "auto") return caps.recommended;

  // Validate the override is available
  switch (override) {
    case "seatbelt":
      if (!caps.hasSandboxExec) {
        throw new Error("sandbox-exec not available on this platform");
      }
      return "seatbelt";
    case "bwrap":
      if (!caps.hasBwrap) {
        throw new Error("bubblewrap (bwrap) not found on PATH");
      }
      return "bwrap";
    case "unshare":
      if (!caps.hasUnshare) {
        throw new Error("unshare not found on PATH");
      }
      if (!caps.userNamespaces) {
        throw new Error("user namespaces not available");
      }
      return "unshare";
    case "none":
      return "none";
  }
}

/** Reset the capability cache (for testing). */
export function resetCapabilitiesCache(): void {
  cached = undefined;
}
