/**
 * `useResourceBridge` — render-time access to the session's resources
 * harness (ADR 62), read off `HookBridges.resources`.
 *
 * Returns `undefined` when no resources harness is wired into the active
 * bridges (e.g. the compiler is running with stub bridges, or a
 * substrate-stripped test mount). The exact analogue of
 * {@link useToolBridge} — React `<Resource>` components call this on
 * mount to register their `uri → resolver` binding.
 *
 * @see docs/proposals/v2/blueprint/62-resources-harness.md
 */

import type { Resources } from "@agentick/spec-next";
import { useBridges } from "@agentick/compiler-react-next";

export function useResourceBridge(): Resources | undefined {
  return useBridges().resources;
}
