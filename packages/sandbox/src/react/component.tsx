/**
 * `<Sandbox>` — React component that materializes a sandbox via the
 * extension's `SandboxBridge`.
 *
 * Renders nothing visible. On mount:
 *   1. Pulls the `SandboxBridge` from `useBridges().sandbox` (must be
 *      installed via `withSandbox()`).
 *   2. Calls `bridge.createHarness(...)` via the compiler's `useData`
 *      blocking primitive — the bridge constructs the harness using
 *      the app's shared substrate, so events flow into `app.events()`.
 *   3. Provides the harness to descendants via React Context.
 *
 * On unmount: `useOnUnmount` runs the harness's `destroy()` command,
 * tearing down the provider's resources and unregistering from the
 * bridge.
 *
 * Multiple `<Sandbox>` instances are fine — each gets a unique id and
 * its own harness, registered with the bridge for cross-tree access.
 */

import * as React from "react";
import { useBridges, useData, useOnUnmount } from "@agentick/compiler-react";
import type { SandboxACL } from "@agentick/spec";
import type { SandboxCreateOptions, SandboxProvider } from "../contract.js";

import "../augment.js";
// Side-effect: pulls the `HookBridges.elicitation` module augmentation into
// the build program. This component reads `bridges.elicitation` below, and
// the main entry is React-free (so it can't carry this), so the /react
// build (which excludes tests) needs the augment loaded here — mirroring
// `mcp/src/integration/with-mcp.ts`.
import "@agentick/elicitation";
import type { SandboxBridge } from "../bridge.js";
import { aclOf, toCreateOptions } from "../create-options.js";
import { SandboxContext } from "./context.js";

export interface SandboxProps {
  /** Stable id for the sandbox within this session. Default: `"primary"`. */
  readonly id?: string;
  /** Provider that creates the sandbox handle. */
  readonly provider: SandboxProvider;
  /** Optional create-time options forwarded to the provider. */
  readonly workspace?: SandboxCreateOptions["workspace"];
  readonly mounts?: SandboxCreateOptions["mounts"];
  readonly allow?: SandboxACL & SandboxCreateOptions["allow"];
  readonly env?: SandboxCreateOptions["env"];
  readonly limits?: SandboxCreateOptions["limits"];
  /** What to do when a permission request times out. Default: "deny". */
  readonly onPermissionTimeout?: "allow-once" | "deny";
  readonly permissionTimeoutMs?: number;
  readonly children?: React.ReactNode;
}

export function Sandbox(props: SandboxProps): React.ReactElement {
  const bridges = useBridges();
  const sandboxBridge = bridges.sandbox as SandboxBridge | undefined;
  const elicitation = bridges.elicitation;
  const id = props.id ?? "primary";

  if (!sandboxBridge) {
    throw new Error(
      "<Sandbox> requires the sandbox extension. " +
        "Add `withSandbox()` to `AppHarnessOptions.extensions`.",
    );
  }
  if (!elicitation) {
    throw new Error(
      "<Sandbox> requires `bridges.elicitation`. The session must wire an " +
        "ElicitationHarness — the permission gate routes through it.",
    );
  }

  const harness = useData(`sandbox:${id}:${props.provider.name}`, () =>
    sandboxBridge.createHarness({
      sandboxId: id,
      provider: props.provider,
      options: toCreateOptions(props),
      elicitation,
      ...(props.allow !== undefined ? { acl: aclOf(props.allow) } : {}),
      ...(props.onPermissionTimeout !== undefined
        ? { permissionTimeoutDecision: props.onPermissionTimeout }
        : {}),
      ...(props.permissionTimeoutMs !== undefined
        ? { permissionTimeoutMs: props.permissionTimeoutMs }
        : {}),
    }),
  );

  useOnUnmount(async () => {
    await harness.destroy();
    sandboxBridge.unregister(id);
  });

  return <SandboxContext.Provider value={harness}>{props.children}</SandboxContext.Provider>;
}
