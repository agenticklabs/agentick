/**
 * `reactPromptRenderer` — `PromptRenderer` for React content.
 *
 * Compiles a `ReactNode` to `RenderedTree` via `compileTemplate` and hands
 * back the tree's context entries unchanged: `ContextSpec.entries` is already
 * `MessageEntry[]` in authoring order (ADR 94), so there is nothing left to
 * project. A `<Section>` lowers into the content of whatever message contains
 * it; free-floating it arrives as its own `role: "grounding"` entry.
 *
 * Diagnostics from the compile pass are dropped here — render failures are
 * surfaced via the `PromptRenderFailed` envelope by the harness.
 */

import type { PromptRenderer } from "@agentick/prompts";
import { compileTemplate, type CompileTemplateOptions } from "@agentick/compiler-react";
import type { ReactNode } from "react";

export interface ReactPromptRendererOptions {
  /**
   * Pass-through to `compileTemplate` — adopters can supply a custom
   * registry of intrinsics, default formatter, or max-iteration cap.
   */
  readonly compile?: CompileTemplateOptions;
  /**
   * Predicate identifying React-shaped content. The default accepts any
   * React element / fragment / array of nodes / string (the common JSX
   * authoring shapes). Adopters can narrow this when sharing a registry
   * with non-React renderers that also accept objects.
   */
  readonly handles?: (content: unknown) => boolean;
}

const DEFAULT_NAME = "react";

export function createReactPromptRenderer(
  options: ReactPromptRendererOptions = {},
): PromptRenderer {
  const handles = options.handles ?? defaultHandles;
  const compileOpts = options.compile ?? {};
  return {
    name: DEFAULT_NAME,
    handles,
    async render(content) {
      // Trust the predicate — by the time we land here, the harness has
      // dispatched based on `handles(content) === true`.
      const node = content as ReactNode;
      const compiled = await compileTemplate(node, compileOpts);
      return compiled.tree.context.entries;
    },
  };
}

/**
 * Singleton with default options — sufficient for most adopters. Use
 * `createReactPromptRenderer({ ... })` only when a custom registry or
 * `handles` predicate is needed.
 */
export const reactPromptRenderer: PromptRenderer = createReactPromptRenderer();

function defaultHandles(content: unknown): boolean {
  // React elements are objects carrying a `$$typeof` symbol. Strings,
  // numbers, arrays, fragments, and portals are all also valid
  // ReactNode shapes — accept the union.
  if (content == null) return false;
  if (typeof content === "string") return true;
  if (typeof content === "number") return true;
  if (Array.isArray(content)) return true;
  if (typeof content === "object") {
    return "$$typeof" in (content as object) || "type" in (content as object);
  }
  return false;
}
