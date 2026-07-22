/**
 * Model-declaration contributor — `<model-declaration>` intrinsic (ADR 56).
 *
 * Produces a `ModelDeclaration` (`{ modelRef, parameters? }`) — the
 * tree-declared per-tick model. This is the model analogue of the
 * `<tool>` → `ToolDeclaration` contributor: the compiler-react
 * `useModelRegistration` hook renders this intrinsic so the collector
 * picks up the declaration; the loop resolves `modelRef` to a live
 * `RegisteredModel` per tick.
 *
 * Distinct from the `<model>` contributor (`./model.ts`), which produces
 * a `SpecConfig` model SELECTION (`by-id` / `by-ref`) + generation
 * knobs. That drives `RenderedTree.config`; this drives
 * `RenderedTree.declarations.model`. Orthogonal concerns, different IR
 * slots.
 *
 * Props derive from {@link ModelDeclaration}; guarded by the
 * {@link _conformance} assertion.
 *
 * @see docs/proposals/v2/blueprint/56-tree-declared-model-per-tick.md
 */

import type { ModelDeclaration } from "@agentick/spec-next";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";
import { omitUndefined } from "@agentick/utils-next";
import type { Exhausted, UnhandledSpecKeys } from "./spec-conformance.js";

/** `<model-declaration>` props, derived from {@link ModelDeclaration}. */
export type ModelDeclarationProps = ModelDeclaration;

type ModelDeclarationForwarded = "modelRef" | "parameters";
type _conformance = Exhausted<
  UnhandledSpecKeys<ModelDeclaration, ModelDeclarationForwarded, never>
>;

export const modelDeclarationContributor: Contributor = {
  type: "model-declaration",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as ModelDeclarationProps;
    if (!props.modelRef) {
      return [
        {
          kind: "diagnostic",
          diagnostic: {
            severity: "warning",
            message: `<model-declaration> without modelRef at ${ctx.scope.path.join("/")}`,
            code: "MISSING_MODEL_REF",
          },
        },
      ];
    }

    const model: ModelDeclaration = {
      ...(omitUndefined({ ...props }) as Partial<ModelDeclaration>),
      modelRef: props.modelRef,
    };

    return [{ kind: "model-declaration", model }];
  },
};
