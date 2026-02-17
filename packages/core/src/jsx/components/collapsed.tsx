import React from "react";

const h = React.createElement;

export interface CollapsedProps {
  name: string;
  group?: string;
  children?: React.ReactNode;
}

/**
 * Collapsed intrinsic wrapper.
 *
 * Compiles to a text content block with semantic metadata:
 * - `rendererTag: "collapsed"` for format-specific rendering
 * - `rendererAttrs: { name, group }` for expand targeting
 *
 * String children pass through as `text` prop.
 * ReactNode children render as child elements — the collector's
 * extractText recursively collects text from them.
 */
export function Collapsed({ name, group, children }: CollapsedProps) {
  if (typeof children === "string" || typeof children === "number") {
    return h("Collapsed", { name, group, text: String(children) });
  }
  // ReactNode children: render as child elements for recursive text extraction
  return h("Collapsed", { name, group }, children);
}
