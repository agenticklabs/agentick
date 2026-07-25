/**
 * `<ProviderTool>` — typed PascalCase wrapper around the `<provider-tool>`
 * intrinsic (Pass D).
 *
 * Declares a PROVIDER-EXECUTED tool — OpenAI `web_search` /
 * `code_interpreter`, Anthropic `server_tool_use`, Google grounding. It
 * compiles to `RenderedTree.declarations.providerTools` and bypasses the
 * tool executor entirely: the adapter whose key matches `provider` maps it
 * into the provider's native tools array, every other adapter passes it
 * through untouched.
 *
 * Distinct from `<Tool>`, which declares a dispatchable `ToolDeclaration`
 * the framework's executor runs. A provider tool has no `inputSchema`,
 * `handlerRef`, confirmation gate, or client relay — the provider owns it.
 *
 * @see packages/compiler/src/collect/contributors/provider-tool.ts
 * @see docs/proposals/v2/blueprint/07-tool-executor.md
 */

import React from "react";
import type { ProviderToolProps } from "@agentick/compiler";

export type { ProviderToolProps };

export function ProviderTool(props: ProviderToolProps): React.ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return React.createElement("provider-tool" as any, props);
}
ProviderTool.displayName = "ProviderTool";
