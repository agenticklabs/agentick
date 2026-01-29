import { createElement, type JSX, Fragment } from "../jsx-runtime";
import { type ComponentBaseProps } from "../jsx-types";
import type { ContentRenderer } from "../../renderers";

/**
 * Generic Renderer component.
 * Wraps children to apply a specific ContentRenderer.
 *
 * This is the base component that Markdown, XML, and other renderer
 * wrappers use internally. You can also use it directly for custom renderers:
 *
 * @example
 * ```tsx
 * <Renderer instance={new MyCustomRenderer()}>
 *   <Message>Content</Message>
 * </Renderer>
 * ```
 */
export interface RendererProps extends ComponentBaseProps {
  /** The renderer instance to apply to children */
  instance: ContentRenderer;
  children?: any;
}

export function Renderer(props: RendererProps): JSX.Element {
  // Renderer is a context provider - doesn't render itself
  // The compiler detects this and applies the renderer to children
  // We return Fragment but preserve the instance prop for detection
  return createElement(Fragment, props);
}
