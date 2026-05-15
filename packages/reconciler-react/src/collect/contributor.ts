/**
 * Contributor protocol.
 *
 * Each known component type — JSX intrinsic, function component, or
 * Fragment symbol — has one Contributor. The collector dispatches by
 * component identity (`element.type`) and the contributor produces
 * `IRFragment`s for that element.
 *
 * Contributors decide whether to recurse into children (most do, by
 * calling `ctx.walk(child)`). Built-in contributors cover the agentick
 * structural grammar; users register additional contributors via the
 * harness API for their own primitives.
 *
 * @see docs/proposals/v2/blueprint/21-reconciler-implementation.md §Layer B
 */

import type { FormatPurpose } from "@agentick/spec";
import type { HostInstance, HostType } from "../host/host-instance.js";
import type { IRFragment } from "./fragments.js";
import type { HostScope } from "../host/host-context.js";

/**
 * Context handed to every Contributor invocation. Lets the contributor
 * recurse, format content, derive stable ids, and read the in-scope
 * formatter binding.
 */
export interface CollectContext {
  /** Current host scope at the contributor's invocation point. */
  readonly scope: HostScope;

  /**
   * Recurse into a child host instance. Returns the fragments
   * contributed by the child + its subtree.
   */
  walk(child: HostInstance): readonly IRFragment[];

  /**
   * Walk a child and flatten its fragments into a content block list
   * (folding text leaves, content-block fragments, and section/message
   * entries into a single flat block sequence).
   *
   * Used by contributors whose parent IS a content container (e.g.,
   * a `<section>` wants to collect its children's text and tool_use
   * blocks into `SectionEntry.content`).
   */
  collectContentBlocks(parent: HostInstance): readonly import("@agentick/spec").ContentBlock[];

  /**
   * Concatenate plain-text children. Used by primitives whose props
   * supply a `name`/`description` and whose children may also carry
   * additional text (`<tool>Use this tool when…</tool>`).
   */
  collectText(parent: HostInstance): string;

  /**
   * Stable identifier seed for an instance. Deterministic across
   * rerenders when the instance retains identity; combines the
   * instance's `hostId` with optional caller-supplied `prefix`.
   */
  stableId(prefix: string, instance: HostInstance): string;

  /**
   * Lookup the in-scope formatter for `purpose`. Falls back to the
   * scope's default formatter when no purpose-specific binding exists.
   */
  formatter(purpose?: FormatPurpose): import("@agentick/spec").FormatterRef;
}

/**
 * Function-shape Contributor. Type-keyed by `type` (the JSX `element.type`).
 *
 * Returning the empty array means "this element contributes nothing"
 * — typically because the work was delegated to a parent contributor
 * (e.g., content blocks fold into their enclosing section/message).
 */
export interface Contributor {
  readonly type: HostType;
  contribute(
    instance: import("../host/host-instance.js").ElementInstance,
    ctx: CollectContext,
  ): readonly IRFragment[];
}
