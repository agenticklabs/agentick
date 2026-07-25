/**
 * prompts testing surface — conformance suite (imports vitest;
 * must never be reachable from the main barrel).
 */

// ────────── Conformance suite (imports vitest — testing-only) ──────────
export {
  runPromptStoreConformance,
  type PromptStoreConformanceOptions,
} from "../store-conformance.js";
