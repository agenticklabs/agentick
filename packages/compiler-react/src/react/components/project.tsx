/**
 * `<Project>` — override a surfacing-capable harness's projection (ADR 63).
 *
 * The React front-end onto the compiler's projection seam. A component
 * that surfaces a harness (e.g. `<Timeline>`) renders its projected
 * content inside `<Project projectionKey="timeline">…</Project>`; the
 * `project` contributor folds the children into a `projection-override`
 * fragment, which SUPPRESSES that harness's lazy default projection and
 * tags the contribution `authored:<key>`.
 *
 * `<Timeline>{fn}` ≡ `<Project projectionKey="timeline">{folded}</Project>`
 * ≡ a functional compiler's `ctx.project("timeline", fn)` — three
 * front-ends onto one compiler-general seam.
 *
 * @see docs/proposals/v2/blueprint/63-compiler-surfacing.md
 */

import * as React from "react";
import type { ReactNode } from "react";

export interface ProjectProps {
  /**
   * Surfacing key this node overrides (`"timeline"`, `"tools"`, …).
   * Named `projectionKey` rather than `key` because React reserves the
   * `key` prop.
   */
  readonly projectionKey: string;
  /** The projected content (e.g. the `<Message>`s a timeline folded). */
  readonly children?: ReactNode;
}

export function Project(props: ProjectProps): React.JSX.Element {
  return React.createElement("project", { projectionKey: props.projectionKey }, props.children);
}
Project.displayName = "Project";
