/**
 * @agentick/sandbox-local — Local sandbox provider
 *
 * OS-level process isolation using macOS seatbelt and Linux bubblewrap/unshare.
 */

// ── Provider ────────────────────────────────────────────────────────────────
export { localProvider } from "./provider";
export type { LocalProviderConfig } from "./provider";

// ── Platform Detection ──────────────────────────────────────────────────────
export { detectCapabilities } from "./platform/detect";
export type { PlatformCapabilities, SandboxStrategy } from "./platform/types";

// ── Network Proxy ───────────────────────────────────────────────────────────
export { NetworkProxyServer } from "./network/proxy";
export type { ProxyServerConfig } from "./network/proxy";
