/**
 * Provider-tool contributor — `<provider-tool>` / `<providerTool>` intrinsic.
 *
 * Produces a `ProviderToolDeclaration` — a PROVIDER-EXECUTED tool (OpenAI
 * `web_search` / `code_interpreter`, Anthropic `server_tool_use`, Google
 * grounding). Unlike `<tool>`, this NEVER reaches the tool executor: the
 * collector folds it onto `RenderedTree.declarations.providerTools`, which
 * the loop threads straight to the executor's `project` phase (the adapter
 * whose key matches `provider` maps it into the provider's native tools
 * array; every other adapter passes it through untouched).
 *
 * This closes the deferred Pass D `<ProviderTool>` sugar TODO: the loop
 * already reads `declarations.providerTools`, and config-level provider
 * tools land later — this is the tree-declared source.
 *
 * Props derive from {@link ProviderToolDeclaration}; every field forwards
 * by spread, guarded by the {@link _conformance} assertion.
 *
 * @see docs/proposals/v2/blueprint/07-tool-executor.md
 */

import type { ProviderToolDeclaration } from "@agentick/spec-next";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";
import { omitUndefined } from "@agentick/utils-next";
import type { Exhausted, UnhandledSpecKeys } from "./spec-conformance.js";

/** `<provider-tool>` props, derived from {@link ProviderToolDeclaration}. */
export type ProviderToolProps = ProviderToolDeclaration;

type ProviderToolForwarded = "provider" | "type" | "name" | "config";
type _conformance = Exhausted<
  UnhandledSpecKeys<ProviderToolDeclaration, ProviderToolForwarded, never>
>;

export const providerToolContributor: Contributor = {
  type: "provider-tool",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as ProviderToolProps;
    if (!props.provider || !props.type) {
      return [
        {
          kind: "diagnostic",
          diagnostic: {
            severity: "warning",
            message: `<provider-tool> missing provider or type at ${ctx.scope.path.join("/")}`,
            code: "MISSING_PROVIDER_TOOL_FIELDS",
          },
        },
      ];
    }
    const providerTool: ProviderToolDeclaration = {
      ...(omitUndefined({ ...props }) as Partial<ProviderToolDeclaration>),
      provider: props.provider,
      type: props.type,
    };
    return [{ kind: "provider-tool-declaration", providerTool }];
  },
};
