/**
 * Surfacing components — put framework-known context in the tree, at a
 * position you chose (ADR 95).
 *
 * ## Why these exist
 *
 * `<MCP>` and `<Resource>` REGISTER — they feed a harness. Surfacing (getting
 * the registered thing into the model's context) was a separate axis with no
 * component, so the compiler did it for you: a lazy default projection,
 * appended after the tree-order stream "because it has no tree position"
 * (`collect.ts`).
 *
 * That put ~35 KB of grounding as the final content before generation in a
 * real app, ending on an unterminated list, and the model CONTINUED it rather
 * than answering — measured, twice. The app's tree deliberately ordered
 * question-last; the framework appended after it. See ADR 95 §1.
 *
 * Rendering one of these emits a `projection-override`, which SUPPRESSES the
 * corresponding default and places the content exactly where you wrote it.
 * That is the whole mechanism: no new machinery, the same bytes, a position.
 *
 * ```jsx
 * <System>…</System>
 * <McpServers />        ← the same default rendering, now with a location
 * <Resources />
 * <Timeline />          ← the conversation stays last
 * ```
 *
 * ## Customising one of twenty
 *
 * The render-prop form hands you the items and the DEFAULT item renderer, so
 * changing one server does not mean hand-writing the other nineteen:
 *
 * ```jsx
 * <McpServers>
 *   {(servers) =>
 *     servers.map((s) =>
 *       s.serverId === "knowify" ? <MyBlock server={s} /> : <McpServerLine server={s} />,
 *     )
 *   }
 * </McpServers>
 * ```
 *
 * @see docs/proposals/v2/blueprint/95-explicit-surfacing.md
 */

import * as React from "react";
import type { ReactNode } from "react";

import { useBridges } from "../bridge-context.js";
import { Project } from "./project.js";
import { Section } from "./section.js";
import {
  mcpServerLine,
  mcpServersText,
  resourcesCatalogText,
  readMcpServerInfos,
  type StructuralServerInfo,
} from "../../harness/default-projections.js";

// ============================================================================
// Resources
// ============================================================================

export interface ResourcesProps {
  /** Override the section heading. */
  readonly title?: string;
  /**
   * Render prop over the catalog TEXT. Omit for the default rendering.
   * Returning `null` surfaces nothing while still suppressing the default —
   * which is how you turn the catalog off without turning resources off.
   */
  readonly children?: (catalog: string | undefined) => ReactNode;
}

/**
 * Surface the resource CATALOG (uris + names + descriptions) at this position.
 *
 * The catalog, not the content: resources are application-controlled and
 * pulled on demand (ADR 62), so the model reads a specific uri with
 * `resource_read`. Renders nothing when the registry is empty — an empty
 * heading is noise, and the suppression of the default still applies.
 */
export function Resources(props: ResourcesProps = {}): React.JSX.Element | null {
  const bridges = useBridges();
  const catalog = resourcesCatalogText(bridges);
  const body = props.children ? props.children(catalog) : catalog;
  if (body === undefined || body === null || body === "") {
    // Still emit the override so the default does not fire behind our back —
    // "I rendered this and chose nothing" must beat "you rendered nothing so
    // I appended 35 KB after your conversation".
    return React.createElement(Project, { projectionKey: "resources" });
  }
  return React.createElement(
    Project,
    { projectionKey: "resources" },
    React.createElement(
      Section,
      { id: "resources-catalog", title: props.title ?? "Available resources" },
      body,
    ),
  );
}
Resources.displayName = "Resources";

// ============================================================================
// MCP servers
// ============================================================================

export interface McpServerLineProps {
  readonly server: StructuralServerInfo;
}

/**
 * ONE connected server's default summary line, keyed by the adopter ALIAS
 * (never the server's self-reported name, which is an untrusted display
 * label). Exported so partial override is possible — see the module docblock.
 */
export function McpServerLine(props: McpServerLineProps): React.JSX.Element {
  return React.createElement(React.Fragment, null, mcpServerLine(props.server));
}
McpServerLine.displayName = "McpServerLine";

export interface McpServersProps {
  readonly title?: string;
  /** Render prop over the connected servers. Omit for the default rendering. */
  readonly children?: (servers: readonly StructuralServerInfo[]) => ReactNode;
}

/**
 * Surface the connected MCP servers at this position. Renders nothing when
 * none are connected, while still suppressing the default.
 */
export function McpServers(props: McpServersProps = {}): React.JSX.Element | null {
  const bridges = useBridges();
  const servers = readMcpServerInfos(bridges) ?? [];
  if (props.children) {
    const rendered = props.children(servers);
    if (rendered === undefined || rendered === null) {
      return React.createElement(Project, { projectionKey: "mcpServerInfo" });
    }
    return React.createElement(
      Project,
      { projectionKey: "mcpServerInfo" },
      React.createElement(
        Section,
        { id: "mcp-server-info", title: props.title ?? "Connected MCP servers" },
        rendered,
      ),
    );
  }
  const text = mcpServersText(bridges);
  if (text === undefined) {
    return React.createElement(Project, { projectionKey: "mcpServerInfo" });
  }
  return React.createElement(
    Project,
    { projectionKey: "mcpServerInfo" },
    React.createElement(
      Section,
      { id: "mcp-server-info", title: props.title ?? "Connected MCP servers" },
      text,
    ),
  );
}
McpServers.displayName = "McpServers";
