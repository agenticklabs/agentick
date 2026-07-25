/**
 * `useSandbox()` — return the active `SandboxHarness` from React Context.
 *
 * Tools authored with `createTool({ use: () => ({ sandbox: useSandbox() }) })`
 * pick up the in-scope sandbox at render time.
 *
 * Returns `null` when no `<Sandbox>` is mounted up the tree — callers
 * either guard or assert non-null based on whether the sandbox is
 * required. Tools that always need a sandbox throw at dispatch time
 * with a clear error message.
 */

import { useContext } from "react";

import { SandboxContext } from "./context.js";
import type { SandboxHarness } from "../harness.js";

export function useSandbox(): SandboxHarness | null {
  return useContext(SandboxContext);
}
