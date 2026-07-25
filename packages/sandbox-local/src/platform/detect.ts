/**
 * Platform capability detection for the local jail (ADR 59, #240).
 *
 * Probes the host for isolation primitives — macOS `sandbox-exec`, Linux
 * bubblewrap / `unshare`, cgroups v2, unprivileged user namespaces — and
 * recommends a {@link SandboxStrategy}. The result is cached after the first
 * call (probes are pure host facts, stable for the process lifetime).
 *
 * `selectStrategy` resolves an operator override against the probe: an
 * explicit `"seatbelt"` on a host without `sandbox-exec` THROWS rather than
 * silently downgrading to passthrough — a jail that quietly doesn't confine
 * is worse than none (ADR 59).
 *
 * Ported from v1 `@agentick/sandbox-local/platform/detect.ts` (node built-ins
 * only; no contract coupling).
 */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { PlatformCapabilities, SandboxStrategy } from "./types.js";

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
 * Detect platform sandbox capabilities. Cached — safe to call repeatedly.
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

/**
 * Select the effective strategy given capabilities and an optional override.
 * `undefined`/`"auto"` → the probed recommendation. An explicit override
 * that the host cannot honor THROWS (never silently downgrades).
 */
export function selectStrategy(
  caps: PlatformCapabilities,
  override?: SandboxStrategy | "auto",
): SandboxStrategy {
  if (!override || override === "auto") return caps.recommended;

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
