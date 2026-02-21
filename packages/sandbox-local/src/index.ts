/**
 * @agentick/sandbox-local — Local sandbox provider
 *
 * OS-level process isolation using macOS seatbelt and Linux bubblewrap/unshare.
 */

// ── Provider ────────────────────────────────────────────────────────────────
export { localProvider } from "./provider.js";
export type { LocalProviderConfig } from "./provider.js";

// ── Platform Detection ──────────────────────────────────────────────────────
export { detectCapabilities } from "./platform/detect.js";
export type { PlatformCapabilities, SandboxStrategy } from "./platform/types.js";

// ── Network Proxy ───────────────────────────────────────────────────────────
export { NetworkProxyServer } from "./network/proxy.js";
export type { ProxyServerConfig } from "./network/proxy.js";
