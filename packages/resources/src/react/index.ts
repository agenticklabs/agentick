/**
 * `@agentick/resources/react` — the React front-end for the
 * resources harness (ADR 62). Depends on `@agentick/compiler-react`'s
 * `useBridges` (via `useResourceBridge`) but NOT the other way around —
 * no cycle (ADR 27 per-harness `/react` convention).
 *
 * @see docs/proposals/v2/blueprint/62-resources-harness.md
 */

export {
  Resource,
  type ResourceProps,
  type FixedResourceProps,
  type TemplateResourceProps,
  type ResourceContentSource,
  type ResourceResolveFn,
} from "./resource.js";
export { useResourceBridge } from "./use-resource-bridge.js";
