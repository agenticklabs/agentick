import { useContext } from "react";
import type { RenderContext } from "@agentick/spec";
import { RenderContextContext } from "../render-context-context.js";

/** The active model for this render — a projection of the {@link ExecutionTarget}. */
export type ActiveModel = NonNullable<RenderContext["activeModel"]>;

/**
 * `useActiveModel` — the model the loop is about to call THIS render
 * (ADR 55): provider + modelId + capabilities. A SYNCHRONOUS render input
 * read from the {@link RenderContext} envelope (`renderContext.activeModel`),
 * resolved session-side and threaded through the loop — the same seam and
 * timing as `useContextInfo`'s window.
 *
 * Render *for the model you'll call*: switch tool descriptions, output
 * formatting, or reasoning scaffolds per provider/model, or gate a section
 * on `capabilities.supportsTools`. Returns `undefined` when the session
 * supplied no active model (e.g. a free-root render outside a run).
 *
 * The slot is spec-resident plain data (no `@agentick/model` dep), so
 * this hook keeps `compiler-react` free of the model layer — mirroring
 * the deliberate choice made for `contextInfo`.
 *
 * @see packages/compiler-react/src/react/hooks/use-context-info.ts
 */
export function useActiveModel(): ActiveModel | undefined {
  return useContext(RenderContextContext)?.activeModel;
}
