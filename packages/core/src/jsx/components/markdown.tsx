import { createElement, type JSX } from "../jsx-runtime";
import { type ComponentBaseProps } from "../jsx-types";
import { MarkdownRenderer, type SemanticContentBlock } from "../../renderers";
import { FormatterBoundary } from "../../state/boundary";

/**
 * Markdown renderer component.
 * Provides markdown rendering context for its children using the unified FormatterBoundary.
 *
 * Usage:
 * ```jsx
 * <Markdown>
 *   <H1>Title</H1>
 *   <Text>Content</Text>
 * </Markdown>
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
export interface MarkdownProps extends ComponentBaseProps {
  /**
   * Markdown flavor: 'github', 'commonmark', or 'gfm'
   */
  flavor?: "github" | "commonmark" | "gfm";
  children?: any;
}

export function Markdown(props: MarkdownProps): JSX.Element {
  // Create renderer for this specific flavor
  const renderer = new MarkdownRenderer(props.flavor);

  return createElement(FormatterBoundary.Provider, {
    value: {
      formatter: (blocks: SemanticContentBlock[]) => renderer.format(blocks),
    },
    children: props.children,
  });
}
