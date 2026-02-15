import React, { useMemo } from "react";
import { useKnob } from "./knob";
import { Collapsed } from "../jsx/components/collapsed";

const h = React.createElement;

let expandableCounter = 0;

export interface ExpandableProps {
  name?: string;
  group?: string;
  summary: string;
  momentary?: boolean;
  children?: React.ReactNode;
}

export function Expandable({ name, group, summary, momentary = true, children }: ExpandableProps) {
  const effectiveName = useMemo(() => name ?? `_expand_${++expandableCounter}`, [name]);

  const [expanded] = useKnob(effectiveName, false, {
    description: `Expand: ${summary}`,
    group,
    inline: true,
    momentary,
  });

  if (!expanded) {
    return h(Collapsed, { name: effectiveName, group }, summary);
  }

  return h(React.Fragment, null, children);
}
