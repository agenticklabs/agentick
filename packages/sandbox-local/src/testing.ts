/**
 * Sandbox Local Testing Utilities
 *
 * Helpers for testing sandbox consumers and the local provider itself.
 */

import { localProvider } from "./provider.js";
import type { LocalProviderConfig } from "./provider.js";
import type { SandboxProvider } from "@agentick/sandbox";
import type { PlatformCapabilities } from "./platform/types.js";

/**
 * Create a test provider with unsandboxed executor by default.
 * Useful for CI and cross-platform tests that don't need OS isolation.
 */
export function createTestProvider(config?: Partial<LocalProviderConfig>): SandboxProvider {
  return localProvider({
    strategy: "none",
    cleanupWorkspace: true,
    ...config,
  });
}

/** Whether the current platform is macOS. */
export const isDarwin = process.platform === "darwin";

/** Whether the current platform is Linux. */
export const isLinux = process.platform === "linux";

/**
 * Create mock PlatformCapabilities for testing.
 */
export function createMockCapabilities(
  overrides?: Partial<PlatformCapabilities>,
): PlatformCapabilities {
  return {
    platform: "darwin",
    arch: "arm64",
    hasSandboxExec: true,
    hasBwrap: false,
    hasUnshare: false,
    hasCgroupsV2: false,
    userNamespaces: false,
    uid: 501,
    recommended: "seatbelt",
    ...overrides,
  };
}
