/**
 * store testing surface — conformance suite (imports vitest;
 * must never be reachable from the main barrel).
 */
// ────────── Conformance suite (imports vitest — testing-only) ──────────
export {
  runStoreConformance,
  type StoreCapabilities,
  type StoreConformanceContext,
  type StoreConformanceOptions,
} from "../store-conformance.js";
