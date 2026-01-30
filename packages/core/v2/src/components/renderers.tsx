/** @jsxImportSource react */
/**
 * V2 Renderer Components
 *
 * Components that switch the renderer context for their children.
 */

import React, { type ReactNode } from "react";
import { registerRendererComponent } from "../reconciler";
import { markdownRenderer, xmlRenderer } from "../renderers";

// ============================================================
// Markdown
// ============================================================

export interface MarkdownProps {
  children?: ReactNode;
}

/**
 * Render children using Markdown format.
 */
export function Markdown({ children }: MarkdownProps): React.JSX.Element {
  return <>{children}</>;
}

// Register as renderer switcher
registerRendererComponent(Markdown, markdownRenderer);
(Markdown as any).displayName = "Markdown";

// ============================================================
// XML
// ============================================================

export interface XMLProps {
  children?: ReactNode;
}

/**
 * Render children using XML format.
 */
export function XML({ children }: XMLProps): React.JSX.Element {
  return <>{children}</>;
}

registerRendererComponent(XML, xmlRenderer);
(XML as any).displayName = "XML";

// ============================================================
// Custom Renderer Wrapper
// ============================================================

/**
 * Create a custom renderer component.
 *
 * @example
 * ```tsx
 * const PlainText = createRendererComponent(plainTextRenderer);
 *
 * <PlainText>
 *   <Section>This will be plain text</Section>
 * </PlainText>
 * ```
 */
export function createRendererComponent(renderer: {
  name: string;
  render: (block: any) => string;
  renderBlocks: (blocks: any[]) => string;
}): React.FC<{ children?: ReactNode }> {
  const Component: React.FC<{ children?: ReactNode }> = ({ children }) => {
    return <>{children}</>;
  };

  Component.displayName = `Renderer(${renderer.name})`;
  registerRendererComponent(Component, renderer);

  return Component;
}
