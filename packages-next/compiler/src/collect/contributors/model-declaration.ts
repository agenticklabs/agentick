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
 * @see docs/proposals/v2/blueprint/56-tree-declared-model-per-tick.md
 */

import type { ModelDeclaration } from "@agentick/spec-next";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";
import { omitUndefined } from "@agentick/utils-next";

interface ModelDeclarationProps {
  readonly modelRef?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

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
      modelRef: props.modelRef,
      ...omitUndefined({ parameters: props.parameters }),
    };

    return [{ kind: "model-declaration", model }];
  },
};
