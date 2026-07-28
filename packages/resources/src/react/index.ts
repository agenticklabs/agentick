/**
 * `@agentick/resources/react` — the React front-end for the
 * resources harness (ADR 62). Depends on `@agentick/compiler-react`'s
 * `useBridges` (via `useResourceBridge`) but NOT the other way around —
 * no cycle (ADR 27 per-harness `/react` convention).
 *
 * @see docs/proposals/v2/blueprint/62-resources-harness.md
 */

// Side-effect import — declares the HookBridges.resources slot this subpath
// READS (`useResourceBridge` → `useBridges().resources`). Without it, a
// consumer that deep-imports `@agentick/resources/react` without also
// importing the package barrel loses the slot's type, which is the whole
// failure mode the per-subpath rule exists to prevent. Five sibling /react
// barrels already do this; this one had rotted.
import "../augment.js";

export {
  Resource,
  type ResourceProps,
  type FixedResourceProps,
  type TemplateResourceProps,
  type ResourceContentSource,
  type ResourceResolveFn,
} from "./resource.js";
export { useResourceBridge } from "./use-resource-bridge.js";
