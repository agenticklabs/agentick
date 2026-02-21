import React, { useMemo } from "react";
import type { JSX } from "react";
import { useKnob } from "./knob.js";

const h = React.createElement;

let expandableCounter = 0;

export type ExpandableRenderFn = (expanded: boolean, name: string) => React.ReactNode;

export interface ExpandableProps {
  name?: string;
  group?: string;
  summary: string;
  momentary?: boolean;
  children?: ExpandableRenderFn;
}

/**
 * Headless expand/collapse toggle.
 *
 * Manages a momentary knob and passes `(expanded, effectiveName)` to its
 * render function. The consumer decides what both states look like —
 * Expandable has no opinion on rendering.
 *
 * @example
 * // Content block: collapsed → Collapsed intrinsic, expanded → Image intrinsic
 * <Expandable name="img:0" summary="[image]">
 *   {(expanded, name) => expanded
 *     ? <image source={src} />
 *     : <Collapsed name={name}>[image]</Collapsed>
 *   }
 * </Expandable>
 *
 * @example
 * // Message: collapsed → summary text, expanded → full content
 * <Expandable name="ref:3" summary="[ref:3] user asked...">
 *   {(expanded) => expanded
 *     ? <MessageInner {...fullProps} />
 *     : <MessageInner {...summaryProps} />
 *   }
 * </Expandable>
 */
export function Expandable({
  name,
  group,
  summary,
  momentary = true,
  children,
}: ExpandableProps): JSX.Element {
  const effectiveName = useMemo(() => name ?? `_expand_${++expandableCounter}`, [name]);

  const [expanded] = useKnob(effectiveName, false, {
    description: `Expand: ${summary.slice(0, 60)}`,
    group,
    inline: true,
    momentary,
  });

  return h(React.Fragment, null, children!(expanded, effectiveName));
}
