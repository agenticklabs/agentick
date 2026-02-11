/**
 * Sandbox Context
 *
 * React context and hook for accessing the nearest Sandbox in the component tree.
 */

import { createContext, useContext } from "react";
import type { Sandbox } from "./types";

export const SandboxContext = createContext<Sandbox | null>(null);

/**
 * Access the nearest Sandbox from the component tree.
 *
 * @throws Error if no `<Sandbox>` provider is found in the tree.
 *
 * @example
 * ```tsx
 * const Shell = createTool({
 *   name: 'shell',
 *   use: () => ({ sandbox: useSandbox() }),
 *   handler: async ({ command }, deps) => {
 *     const result = await deps!.sandbox.exec(command);
 *     return [{ type: 'text', text: result.stdout }];
 *   },
 * });
 * ```
 */
export function useSandbox(): Sandbox {
  const sandbox = useContext(SandboxContext);
  if (!sandbox) {
    throw new Error(
      "useSandbox(): No sandbox found. Wrap your component tree with <Sandbox provider={...}>.",
    );
  }
  return sandbox;
}
