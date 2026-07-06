/**
 * `ContextInfoContext` — the CURRENT tick's model info as a synchronous
 * render input (ADR 54 (b)).
 *
 * Model info that must affect the IR being produced (the active model's
 * `contextWindow`) is a render INPUT, not something observed after the
 * render via an async lifecycle setState — routing it through a hook
 * setState races the reconciler's synchronous render and never reaches
 * the current IR. The session resolves it per render (via
 * `effectiveModelInfo(activeModel, models)`) and threads it in; the
 * reconciler provides it here; `useContextInfo` reads it synchronously.
 *
 * Past facts (usedTokens) still flow via the async lifecycle bridge —
 * they're historical and non-blocking.
 */

import { createContext } from "react";

export interface RenderContextInfo {
  /** The active model's context window for THIS render, if known. */
  readonly contextWindow?: number;
  /** Prior-turn input tokens, if the session provided them at render. */
  readonly usedTokens?: number;
}

export const ContextInfoContext = createContext<RenderContextInfo | null>(null);
