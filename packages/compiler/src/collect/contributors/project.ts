/**
 * Projection-override contributor — `<project>` intrinsic (ADR 63).
 *
 * A `<project projectionKey="timeline">…</project>` node declares that a
 * component is OVERRIDING its harness's projection for that key. The
 * children are the projected content (e.g. the `<Message>`s a `<Timeline>`
 * folded); this contributor collects their `context-entry` fragments into
 * the override's {@link ProjectionResult} and emits a single
 * `projection-override` fragment.
 *
 * Presence of that fragment suppresses the harness's lazy default
 * projection for the key (an overridden timeline is never re-folded).
 * Non-entry fragments produced inside the subtree (diagnostics, and any
 * `tool-declaration` sources) are re-emitted unchanged so they are not
 * lost — only the *surfacing* is overridden, not upstream registration.
 *
 * This intrinsic is the React front-end onto the compiler-general
 * projection seam; a functional compiler calls `ctx.project(key, fn)`
 * for the same effect.
 *
 * @see docs/proposals/v2/blueprint/63-compiler-surfacing.md
 */

import type { MessageEntry } from "@agentick/spec";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";

/**
 * `<project>` props. NO spec-derivation partition here (a deliberate
 * exception to the contributor ownership convention): this contributor
 * emits a COMPILER-INTERNAL `projection-override` IR fragment (ADR 63),
 * not one of the spec's `RuntimeDeclarations` / `MessageEntry` types. Its
 * only prop — `projectionKey` — is a compiler surfacing key with no spec
 * type to derive from, so there is nothing to `Omit`/partition.
 */
export interface ProjectProps {
  /**
   * Surfacing key this node overrides. Named `projectionKey` (not `key`)
   * because React reserves the `key` prop.
   */
  readonly projectionKey?: string;
}

export const projectContributor: Contributor = {
  type: "project",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as ProjectProps;
    if (!props.projectionKey) {
      return [
        {
          kind: "diagnostic",
          diagnostic: {
            severity: "warning",
            message: `<project> without projectionKey at ${ctx.scope.path.join("/")}`,
            code: "MISSING_PROJECTION_KEY",
          },
        },
      ];
    }

    const entries: MessageEntry[] = [];
    const passthrough: IRFragment[] = [];
    for (const child of instance.children) {
      for (const frag of ctx.walk(child)) {
        if (frag.kind === "context-entry") {
          entries.push(frag.entry);
        } else {
          passthrough.push(frag);
        }
      }
    }

    return [
      { kind: "projection-override", key: props.projectionKey, result: { entries } },
      ...passthrough,
    ];
  },
};
