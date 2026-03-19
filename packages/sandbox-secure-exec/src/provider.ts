/**
 * Secure-Exec Sandbox Provider
 *
 * Factory function that creates a SandboxProvider backed by V8 isolates
 * via the secure-exec library. ~3.4MB per sandbox, 16ms cold start.
 */

import { randomBytes } from "node:crypto";
import type { SandboxProvider, SandboxHandle, SandboxCreateOptions } from "@agentick/sandbox";
import type { Permissions as SecureExecPermissions } from "secure-exec";
import {
  NodeRuntime,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
  createInMemoryFileSystem,
  createDefaultNetworkAdapter,
} from "secure-exec";

/** Extract the request type for a specific permission check. */
type PermResult = { allow: boolean; reason?: string };
type FsRequest = SecureExecPermissions["fs"] extends ((req: infer R) => unknown) | undefined
  ? R
  : never;
type NetRequest = SecureExecPermissions["network"] extends ((req: infer R) => unknown) | undefined
  ? R
  : never;
import { MountAwareVFS } from "./filesystem.js";
import { SecureExecSandbox } from "./sandbox.js";
import type { SecureExecProviderConfig } from "./types.js";

export function secureExecProvider(config?: SecureExecProviderConfig): SandboxProvider {
  const memoryLimit = config?.memoryLimit ?? 128;
  const cpuTimeLimitMs = config?.cpuTimeLimitMs ?? 30_000;
  const workspacePath = config?.workspacePath ?? "/workspace";
  const moduleAccess = config?.moduleAccess ?? process.cwd();
  const networkEnabled = config?.network ?? false;
  const persistence = config?.persistence;
  const timingMitigation = config?.timingMitigation ?? "off";

  return {
    name: "secure-exec",

    async create(options: SandboxCreateOptions): Promise<SandboxHandle> {
      const sandboxId = randomBytes(8).toString("hex");

      // Create in-memory VFS
      const inMemoryFs = createInMemoryFileSystem();
      const vfs = new MountAwareVFS(inMemoryFs, workspacePath);

      // Ensure workspace directory exists
      await inMemoryFs.mkdir(workspacePath);

      // Register user mounts
      if (options.mounts) {
        for (const mount of options.mounts) {
          vfs.addMount(mount);
        }
      }

      // Resolve network from options or config
      const net = options.permissions?.net;
      const enableNetwork = net === true || (net !== false && net != null) || networkEnabled;

      // Build permission functions from SandboxCreateOptions
      const fsPermission = buildFsPermission();
      const networkPermission = buildNetworkPermission(net, enableNetwork);
      const childProcessAllowed = options.permissions?.childProcess !== false;

      // Build system driver
      const driverOptions: Parameters<typeof createNodeDriver>[0] = {
        filesystem: inMemoryFs,
        moduleAccess: moduleAccess !== false ? { cwd: moduleAccess as string } : undefined,
        permissions: {
          fs: fsPermission,
          network: networkPermission,
          childProcess: (): PermResult => ({ allow: childProcessAllowed }),
          env: (): PermResult => ({ allow: true }),
        },
        processConfig: {
          cwd: workspacePath,
          env: {
            HOME: workspacePath,
            PATH: "/usr/local/bin:/usr/bin:/bin",
            NODE_ENV: "production",
            ...options.env,
          },
        },
      };

      // Enable network adapter if needed
      if (enableNetwork) {
        driverOptions.networkAdapter = createDefaultNetworkAdapter();
      }

      const systemDriver = createNodeDriver(driverOptions);

      // Build runtime
      const resolvedMemory = options.limits?.memory
        ? Math.ceil(options.limits.memory / (1024 * 1024))
        : memoryLimit;

      const resolvedTimeout = options.limits?.timeout ?? cpuTimeLimitMs;

      const runtime = new NodeRuntime({
        systemDriver,
        runtimeDriverFactory: createNodeRuntimeDriverFactory(),
        memoryLimit: resolvedMemory,
        cpuTimeLimitMs: resolvedTimeout,
        timingMitigation,
      });

      // Load persisted state if available
      if (persistence) {
        try {
          await persistence.load(sandboxId, vfs);
        } catch {
          // No persisted state — fresh sandbox
        }
      }

      return new SecureExecSandbox(sandboxId, workspacePath, runtime, vfs, persistence);
    },
  };
}

// ── Permission builders ────────────────────────────────────────────────────

function buildFsPermission(): (request: FsRequest) => PermResult {
  // Allow all paths — the MountAwareVFS handles boundary enforcement.
  // The isolate's fs operations go through the VFS which validates paths.
  return () => ({ allow: true });
}

function buildNetworkPermission(
  net: boolean | import("@agentick/sandbox").NetworkRule[] | undefined,
  enabled: boolean,
): (request: NetRequest) => PermResult {
  if (!enabled) {
    return () => ({ allow: false, reason: "Network access disabled" });
  }

  if (net === true || net === undefined || net === false) {
    return () => ({ allow: enabled });
  }

  // NetworkRule[] — evaluate rules in order, first match wins, default deny
  return (request) => {
    for (const rule of net) {
      if (matchesNetworkRule(rule, request.hostname)) {
        return { allow: rule.action === "allow" };
      }
    }
    return { allow: false, reason: "No matching network rule (default deny)" };
  };
}

function matchesNetworkRule(
  rule: import("@agentick/sandbox").NetworkRule,
  hostname?: string,
): boolean {
  if (!rule.domain) return true;

  if (!hostname) return false;

  if (rule.domain.startsWith("*.")) {
    const suffix = rule.domain.slice(1); // ".example.com"
    return hostname.endsWith(suffix) || hostname === rule.domain.slice(2);
  }

  return hostname === rule.domain;
}
