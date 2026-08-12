/**
 * `defineSandbox` — the sandbox NAMESPACE DEFINITION (ADR 93, the ADR-42
 * declarative arm). A placement choice plus the create-time shape:
 *
 * ```ts
 * createApp(<Agent />, { sandbox: defineSandbox({ provider: localProvider() }) });
 * ```
 *
 * Provider packages (`@agentick/sandbox-local`, `-docker`) re-export
 * `defineSandbox` with their provider baked, so the import IS the placement
 * choice. Sandbox has no safe default provider — local vs docker vs lambda are
 * different trust postures — so the base `provider` is optional and a
 * provider-less definition mounts the bridge without spinning a jail.
 *
 * @see docs/proposals/v2/blueprint/93-namespace-definitions.md
 * @see docs/proposals/v2/code-runtime-composition.md
 */

import type { SandboxProvider } from "./contract.js";
import type { SandboxShape } from "./create-options.js";

export interface SandboxDefinition extends SandboxShape {
  /**
   * The placement provider. Omitted, `withSandbox` registers the bridge but
   * spins no sandbox — the `<Sandbox provider={…}>` JSX path supplies one per
   * mount instead.
   */
  readonly provider?: SandboxProvider;
  /** Id for the auto-spun sandbox. Default: `"primary"` (what the tools reach). */
  readonly id?: string;
  /** Decision when a permission elicitation times out. Default: `"deny"`. */
  readonly onPermissionTimeout?: "allow-once" | "deny";
  readonly permissionTimeoutMs?: number;
}

export function defineSandbox(config: SandboxDefinition = {}): SandboxDefinition {
  return config;
}
