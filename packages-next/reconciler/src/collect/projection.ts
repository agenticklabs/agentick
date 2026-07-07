/**
 * Surfacing projections (ADR 63).
 *
 * The compiler produces the model-input IR from two kinds of
 * contribution:
 *
 *   - **content** — `<Message>` / `<Section>` / `<Text>` written directly
 *     in the tree. These append to the ordered entry stream in tree
 *     order. (In the collector these arrive as `context-entry`
 *     fragments — the append behavior predates ADR 63.)
 *   - **projections** — each *surfacing-capable harness* (timeline, tools,
 *     …) has exactly ONE projection into the IR: either its framework
 *     **default** projection, or a component that **overrides** that
 *     harness's projection for a key (a `projection-override` fragment,
 *     emitted by the `<project>` contributor).
 *
 * Accumulation (unioning many `<Tool>` sources, holding the timeline log)
 * lives in the harnesses — NOT here. Surfacing just *projects* what a
 * harness already accumulated. Registration (`<Tool>`, `<Resource>`) feeds
 * a source into its harness and is a separate axis from surfacing.
 *
 * This module is **compiler-general**: a functional compiler
 * (`agent((ctx) => IRNode[])`) drives the same `DefaultProjection` /
 * override split via `ctx.project(key, fn)`. Nothing here is
 * React-specific.
 *
 * @see docs/proposals/v2/blueprint/63-compiler-surfacing.md
 */

import type { ContextEntry, ToolDeclaration } from "@agentick/spec-next";

// ============================================================================
// Projection result + sources
// ============================================================================

/**
 * What a projection (default or override) contributes to the IR. A
 * projection may add context entries (timeline, sections), tool
 * declarations (tools), or both. Empty fields contribute nothing.
 */
export interface ProjectionResult {
  readonly entries?: readonly ContextEntry[];
  readonly tools?: readonly ToolDeclaration[];
}

/**
 * The accumulated sources a default projection reads from. Built by the
 * collector from what it walked (e.g., every `<tool>` registration feeds
 * `tools`). This is the compiler's view of what the harnesses
 * accumulated for this tick.
 *
 * Wave 4b extends this with `resources`, `mcpServers`, … as those
 * default projections land.
 */
export interface ProjectionSources {
  /** Tool declarations registered into the tree (each `<Tool>` = one). */
  readonly tools: readonly ToolDeclaration[];
}

/**
 * A framework default projection for one surfacing-capable harness key.
 *
 * `project` runs LAZILY — the collector calls it ONLY when the tree did
 * not override `key` (no `projection-override` fragment for it). An
 * overridden harness's default is never computed (e.g. an overridden
 * timeline is never folded).
 */
export interface DefaultProjection {
  /** Surfacing key this default owns, e.g. `"timeline"`, `"tools"`. */
  readonly key: string;
  /** Compute the default contribution from the accumulated sources. */
  project(sources: ProjectionSources): ProjectionResult;
}

// ============================================================================
// Built-in default projections
// ============================================================================

/**
 * The `tools` default projection — advertise every tool source
 * registered into the tree. Compiler-agnostic: it reads only
 * `sources.tools` (the accumulated `<Tool>` / MCP-tool registrations),
 * so it lives here rather than in a reconciler binding.
 *
 * Default is applied by {@link collect} when the caller does not pass an
 * explicit `defaults` list, so tools surface with zero configuration.
 *
 * TODO(#237-4b): filter to `exposure.includes("model")` once the
 * executor's compile-for-tick exposure filter is reconciled with this
 * projection (advertising all sources today preserves the pre-ADR-63
 * behavior where `declarations.tools` carried every declaration and the
 * executor filtered downstream). A `<Tools>` override component (filter /
 * suppress) is the authored counterpart and also lands with Wave 4b.
 */
export const builtInToolsProjection: DefaultProjection = {
  key: "tools",
  project: (sources) => (sources.tools.length > 0 ? { tools: sources.tools } : {}),
};

/**
 * The built-in default projection set applied by {@link collect} when the
 * caller does not supply its own. Ships `tools` only at the
 * compiler-agnostic layer — the `timeline` default needs a live timeline
 * harness and is contributed by the reconciler binding
 * (`@agentick/reconciler-react-next`), which reads it structurally from
 * `HookBridges.timeline`.
 */
export const builtInDefaultProjections: readonly DefaultProjection[] = [builtInToolsProjection];
