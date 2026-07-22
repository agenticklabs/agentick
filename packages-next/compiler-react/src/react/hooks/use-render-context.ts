import { useContext } from "react";
import type { RenderContext } from "@agentick/spec-next";
import { RenderContextContext } from "../render-context-context.js";

/**
 * `useRenderContext` — read the current render's {@link RenderContext}
 * envelope (ADR 55): the augmentable bag of per-render facts (window
 * today; active model / budget / principal via augmented slots) the tree
 * reads synchronously while producing the IR.
 *
 * Returns an empty object when the mount has no render-context (rendered
 * outside a runtime, or the session supplied none). Per-slot readers
 * (`useContextInfo`, and future `useActiveModel` / `useBudget`) are thin
 * wrappers over this.
 */
export function useRenderContext(): RenderContext {
  return useContext(RenderContextContext) ?? {};
}
