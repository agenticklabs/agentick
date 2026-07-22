/**
 * Render-context — the runtime-provided envelope of facts about THIS
 * render that the tree reads *synchronously while producing the IR*.
 *
 * This is the render-INPUT analogue of {@link HookBridges} (ADR 55). Where
 * `HookBridges` is the empty-seed envelope of runtime *implementations*
 * hooks call into, `RenderContext` is the empty-seed envelope of runtime
 * *facts* the current render is a function of. Both stay neutral in spec;
 * packages contribute slots via TypeScript module augmentation:
 *
 *   declare module "@agentick/spec-next" {
 *     interface RenderContext {
 *       readonly activeModel?: { readonly id: string; readonly provider: string };
 *     }
 *   }
 *
 * Spec does NOT hardcode foundational slots. The one seeded slot below
 * (`contextInfo`) is the render loop's own fact — the active model's
 * window for this render — because the loop/session is its producer and
 * has no package of its own to augment from. Future per-render facts
 * (active model #169, budget #186, principal/scopes from identity,
 * progress/last-stop) land as augmented slots, each a rider on the
 * session's resolver — no spec widening per fact.
 *
 * ## Why a render INPUT, not a lifecycle observation (ADR 54)
 *
 * A fact that must shape the current IR (the window, the active model)
 * MUST ride render-context: it is resolved by the session, threaded
 * through the loop into `renderTree`, and provided as a React context read
 * *synchronously* during the render. Routing it through the async
 * lifecycle projection (`dispatchLifecycle` → `setState`) races the
 * synchronous render and never reaches the IR. The two channels split by tense:
 * render-context is forward-looking ("what is true for the render I am
 * about to produce?"); the lifecycle bridge is backward-looking ("what
 * just happened?").
 *
 * @see docs/proposals/v2/blueprint/55-render-context-seam.md
 * @see docs/proposals/v2/blueprint/03-reconciler-harness.md §Hooks model
 */

import type { ExecutionTarget } from "../data/execution-target.js";

export interface RenderContext {
  /**
   * The active model's window facts for THIS render (ADR 54/55).
   * Framework-produced by the loop/session; plain numbers, no
   * model-next dep. `contextWindow` is a synchronous render input;
   * `usedTokens` is the prior turn's consumed tokens when the session
   * supplies it at render.
   */
  readonly contextInfo?: {
    readonly contextWindow?: number;
    readonly usedTokens?: number;
  };

  /**
   * The model the loop is about to call THIS render (ADR 55) — a
   * projection of the active {@link ExecutionTarget}. A seeded
   * framework-core slot (identity + capabilities are spec-resident, no
   * model-next dep), so `compiler-react`'s `useActiveModel` reads it
   * with zero model-layer coupling — the same choice `contextInfo` made
   * for the window. Enables *rendering for the model you'll call*
   * (per-model tool descriptions / formatting / reasoning scaffolds).
   *
   * Today the model is construction-bound (`session.target`), so this is
   * stable across ticks. TODO(trail-per-tick-model): under #169 it's
   * IR-derived per tick and a change re-resolves this slot.
   */
  readonly activeModel?: Pick<ExecutionTarget, "provider" | "modelId" | "capabilities">;
}
