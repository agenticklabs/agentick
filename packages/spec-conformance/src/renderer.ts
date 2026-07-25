/**
 * Conformance suite for Renderer implementations.
 *
 * Stub: signature only. Bodies populated in Phase 4a.
 *
 * Invariants the suite will validate:
 *   - Renderer never mutates input content
 *   - Renderer output is JSON-shaped (no live instances)
 *   - Capability declarations match actual rendering ability
 *   - Nested RenderScope evaluates recursively without crossing
 *     unrelated content boundaries
 */
export function runRendererConformance(
  // factory: () => Renderer,
  _factory: () => unknown,
): void {
  // TODO(phase-4a): implement after Renderer protocol + at least one
  // concrete renderer (markdown) is implemented.
  throw new Error("runRendererConformance: not yet implemented (Phase 4a)");
}
