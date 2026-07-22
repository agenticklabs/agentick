/**
 * `RenderContextContext` — the current render's {@link RenderContext}
 * envelope as a synchronous render input (ADR 54 / 55).
 *
 * Facts that must affect the IR being produced (the active model's
 * `contextWindow`, and — via augmented slots — the active model, budget,
 * principal) are render INPUTS, not things observed after the render via
 * an async lifecycle setState: routing them through a hook setState races
 * the compiler's synchronous render and never reaches the current IR.
 * The session resolves the whole envelope per render (`contextInfo` via
 * `effectiveModelInfo(activeModel, models)`) and threads it in; the
 * compiler provides it here; `useContextInfo` / `useRenderContext` and
 * future per-slot readers consume it synchronously.
 *
 * Past facts (usedTokens, tool outcomes) still flow via the async
 * lifecycle bridge — they're historical and non-blocking.
 *
 * @see docs/proposals/v2/blueprint/55-render-context-seam.md
 */

import { createContext } from "react";
import type { RenderContext } from "@agentick/spec-next";

export const RenderContextContext = createContext<RenderContext | null>(null);
