/**
 * `<MCPTools>` — surfaces tools discovered by `withMCP` into the
 * rendered tree.
 *
 * The loop executor builds the model's tool list from
 * `RenderedTree.declarations.tools`, which the reconciler collects
 * from `<tool>` intrinsics in the JSX tree. Tools that exist only in
 * the `ToolExecutor.initialTools` registry (the host-dispatch path)
 * aren't visible to the model.
 *
 * `withMCP` already does the heavy lifting — opens connections,
 * lists tools, registers handlers on the shared HandlerResolver.
 * This component just reads the resolved list off `bridges.mcp.tools`
 * and renders one `<tool>` intrinsic per discovered tool so the
 * declarations land in the rendered tree.
 *
 * ```tsx
 * function MyAgent() {
 *   return (
 *     <>
 *       <System>You can use any of the MCP-provided tools.</System>
 *       <MCPTools />                            // all discovered tools
 *       // or:
 *       <MCPTools serverId="linear" />          // scoped to one server
 *     </>
 *   );
 * }
 * ```
 *
 * Adopters who want JSX-side filtering (e.g., hide destructive tools)
 * read `useBridges().mcp?.tools` directly and render `<tool>`
 * intrinsics themselves — `<MCPTools>` is the convenience.
 */

import React from "react";

import { useBridges } from "@agentick/reconciler-react-next";

export interface MCPToolsProps {
  /** Filter to one server's tools. Omit to surface all discovered tools. */
  readonly serverId?: string;
}

export function MCPTools(props: MCPToolsProps = {}): React.ReactElement | null {
  const bridges = useBridges();
  const all = bridges.mcp?.tools ?? [];
  const tools =
    props.serverId === undefined ? all : all.filter((t) => t.serverId === props.serverId);
  if (tools.length === 0) return null;

  return React.createElement(
    React.Fragment,
    null,
    ...tools.map((t) =>
      React.createElement("tool", {
        key: t.declaration.name,
        name: t.declaration.name,
        description: t.declaration.description,
        inputSchema: t.declaration.inputSchema,
        ...(t.declaration.outputSchema !== undefined
          ? { outputSchema: t.declaration.outputSchema }
          : {}),
        exposure: t.declaration.exposure,
        handlerRef: t.declaration.handlerRef,
        ...(t.declaration.annotations !== undefined
          ? { annotations: t.declaration.annotations }
          : {}),
        ...(t.declaration.metadata !== undefined ? { metadata: t.declaration.metadata } : {}),
      }),
    ),
  );
}
