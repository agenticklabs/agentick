/**
 * InMemoryModelBridge — reference `ModelBridge` implementation (ADR 56).
 *
 * The live side of tree-declared per-tick model selection. A plain
 * `Map<modelRef, RegisteredModel>`:
 *   - `register(ref, model)` — stores the run-ready model, returns an
 *     unsubscribe that deletes it (last-writer-wins on the same ref).
 *   - `unregister(ref)` — drops the entry.
 *   - `resolve(ref)` — reads the entry (or `undefined`).
 *
 * The exact structural analogue of the tool `HandlerResolver`: the IR
 * carries a serializable `modelRef`, this bridge maps it to the live
 * executor + target. `reconciler-react`'s `useModelRegistration`
 * registers here at render time; the loop's `resolveModel` closes over
 * an instance and looks refs up per tick.
 *
 * @see docs/proposals/v2/blueprint/56-tree-declared-model-per-tick.md
 * @see packages-next/spec/src/protocol/hook-bridges.ts (ModelBridge)
 */

import type { ModelBridge, RegisteredModel, Unsubscribe } from "@agentick/spec-next";

export class InMemoryModelBridge implements ModelBridge {
  private readonly models = new Map<string, RegisteredModel>();

  register(modelRef: string, model: RegisteredModel): Unsubscribe {
    this.models.set(modelRef, model);
    return () => {
      // Only delete if this exact registration is still the live one —
      // a later re-register on the same ref (last-writer-wins) must not
      // be clobbered by a stale unsubscribe.
      if (this.models.get(modelRef) === model) this.models.delete(modelRef);
    };
  }

  unregister(modelRef: string): void {
    this.models.delete(modelRef);
  }

  resolve(modelRef: string): RegisteredModel | undefined {
    return this.models.get(modelRef);
  }
}
