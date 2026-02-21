/**
 * Sandbox Component
 *
 * JSX component that creates and provides a Sandbox instance to its children.
 * Uses useData for async initialization and useOnUnmount for cleanup.
 */

import type React from "react";
import { useData, useOnUnmount } from "@agentick/core";
import { SandboxContext } from "./context.js";
import type {
  SandboxProvider,
  SandboxCreateOptions,
  Mount,
  Permissions,
  ResourceLimits,
  Sandbox as SandboxHandle,
} from "./types.js";

export interface SandboxProps {
  /** The sandbox provider to use (e.g. localProvider()). */
  provider: SandboxProvider;

  /** Workspace path, or true for auto temp directory. Default: true. */
  workspace?: string | true;

  /** Host↔sandbox path mappings. */
  mounts?: Mount[];

  /** Advisory permissions. */
  allow?: Permissions;

  /** Environment variables. Functions are resolved at creation time. */
  env?: Record<string, string | (() => string)>;

  /** Post-creation setup callback. */
  setup?: (sandbox: SandboxHandle) => Promise<void>;

  /** Resource constraints. */
  limits?: ResourceLimits;

  /** Whether to persist sandbox state in snapshots. Default: false. */
  persist?: boolean;

  children: React.ReactNode;
}

/**
 * Creates a sandbox instance and provides it to children via context.
 *
 * @example
 * ```tsx
 * <Sandbox provider={localProvider()}>
 *   <Shell />
 *   <ReadFile />
 *   <WriteFile />
 *   <EditFile />
 *   <MyAgent />
 * </Sandbox>
 * ```
 */
export function Sandbox({
  provider,
  workspace = true,
  mounts,
  allow,
  env,
  setup,
  limits,
  children,
}: SandboxProps): React.ReactElement {
  // Resolve env functions to plain strings
  const resolvedEnv = env
    ? Object.fromEntries(
        Object.entries(env).map(([k, v]) => [k, typeof v === "function" ? v() : v]),
      )
    : undefined;

  const options: SandboxCreateOptions = {
    workspace,
    mounts,
    permissions: allow,
    env: resolvedEnv,
    limits,
  };

  const sandbox = useData("sandbox", async () => {
    const sb = await provider.create(options);
    if (setup) await setup(sb);
    return sb;
  });

  useOnUnmount(() => {
    sandbox.destroy();
  });

  return <SandboxContext.Provider value={sandbox}>{children}</SandboxContext.Provider>;
}
