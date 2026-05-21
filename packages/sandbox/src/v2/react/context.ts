/**
 * React Context exposing the active `SandboxHarness` to descendants.
 *
 * `<Sandbox>` populates this on mount; `useSandbox()` reads it. Tools
 * authored with `createTool({ use: () => ({ sandbox: useSandbox() }) })`
 * capture the harness at render time and pass it through to the
 * handler.
 *
 * When multiple `<Sandbox>` components are mounted, each owns its own
 * Context provider — innermost wins for descendants. Adopters who need
 * cross-section sandbox routing query the `SandboxBridge` by id
 * directly instead of relying on Context.
 */

import { createContext } from "react";

import type { SandboxHarness } from "../harness.js";

export const SandboxContext = createContext<SandboxHarness | null>(null);
