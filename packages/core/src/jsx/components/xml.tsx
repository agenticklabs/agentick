import React from "react";
import type { JSX } from "react";
import { type ComponentBaseProps } from "../jsx-types";
import { XMLRenderer, type SemanticContentBlock } from "../../renderers";
import { FormatterBoundary } from "../../hooks/formatter-context";

// Helper for createElement
const h = React.createElement;

// Create a single XMLRenderer instance for all XML components
const xmlRenderer = new XMLRenderer();

/**
 * XML renderer component.
 * Provides XML rendering context for its children using the unified FormatterBoundary.
 *
 * Usage:
 * ```jsx
 * <XML>
 *   <H1>Title</H1>
 *   <Text>Content</Text>
 * </XML>
 * ```
 *
 * To get the current formatter during render:
 * ```tsx
 * const formatterValue = useBoundary(FormatterBoundary);
 * if (formatterValue) {
 *   const formatted = formatterValue.formatter(blocks);
 * }
 * ```
 */
export interface XMLProps extends ComponentBaseProps {
  children?: any;
}

export function XML(props: XMLProps): JSX.Element {
  return h(FormatterBoundary.Provider, {
    value: {
      formatter: (blocks: SemanticContentBlock[]) => xmlRenderer.format(blocks),
    },
    children: props.children,
  });
}
