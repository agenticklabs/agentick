import React from "react";

const h = React.createElement;

export interface CollapsedProps {
  name: string;
  group?: string;
  children?: string;
}

export function Collapsed({ name, group, children }: CollapsedProps) {
  return h("Collapsed", { name, group, text: children ?? "" });
}
