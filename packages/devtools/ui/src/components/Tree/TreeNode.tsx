import type { FiberNode, TokenSummary } from "../../hooks/useDevToolsEvents";
import { useTreeContext } from "./TreeContext";
import { formatTokens } from "../../utils/format";

interface TreeNodeProps {
  node: FiberNode;
  depth?: number;
  tokenSummary?: TokenSummary;
}

export function TreeNode({ node, depth = 0, tokenSummary }: TreeNodeProps) {
  const { expandedNodes, selectedNodeId, toggleNode, selectNode } = useTreeContext();

  const isExpanded = expandedNodes.has(node.id);
  const isSelected = selectedNodeId === node.id;
  const hasChildren = node.children.length > 0;
  const hasHooks = node.hooks.length > 0;

  // Determine node style based on type
  const isComponent = /^[A-Z]/.test(node.type);
  const isIntrinsic = node.type.startsWith("tentickle.") || /^[a-z]/.test(node.type);
  const isFragment = node.type === "Fragment" || node.type === "tentickle.fragment";

  // Skip rendering fragment nodes, just render children
  if (isFragment) {
    return (
      <>
        {node.children.map((child) => (
          <TreeNode key={child.id} node={child} depth={depth} tokenSummary={tokenSummary} />
        ))}
      </>
    );
  }

  // Get text preview for display
  const getPreview = (): string | null => {
    if (node._summary) return node._summary;

    // Tool components: show the tool name
    if (node.type === "tool" && node.props.name) {
      return String(node.props.name);
    }

    if (node.type === "text" && node.props.value) {
      const text = String(node.props.value);
      return text.length > 40 ? `"${text.slice(0, 40)}..."` : `"${text}"`;
    }
    if (node.props.text) {
      const text = String(node.props.text);
      return text.length > 40 ? `"${text.slice(0, 40)}..."` : `"${text}"`;
    }
    // Entry nodes: show role and content preview from message.content
    if (node.type === "entry" && node.props.message) {
      const msg = node.props.message as { role?: string; content?: unknown[] };
      const role = msg.role ?? "?";
      const content = msg.content ?? [];

      // Collect different block types
      const textBlocks: string[] = [];
      const toolUseBlocks: string[] = [];
      const toolResultBlocks: string[] = [];

      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;

        if (b.type === "text" && typeof b.text === "string") {
          textBlocks.push(b.text);
        } else if (b.type === "tool_use" && typeof b.name === "string") {
          toolUseBlocks.push(b.name);
        } else if (b.type === "tool_result") {
          // Tool result has nested content
          const resultContent = b.content as unknown[] | undefined;
          if (Array.isArray(resultContent)) {
            for (const rc of resultContent) {
              if (
                typeof rc === "object" &&
                rc !== null &&
                (rc as Record<string, unknown>).type === "text"
              ) {
                const text = (rc as Record<string, unknown>).text as string;
                toolResultBlocks.push(text);
              }
            }
          }
        }
      }

      // Build preview based on content types
      const parts: string[] = [];

      if (textBlocks.length > 0) {
        const text = textBlocks.join(" ");
        const preview = text.length > 25 ? text.slice(0, 25) + "..." : text;
        parts.push(`"${preview}"`);
      }

      if (toolUseBlocks.length > 0) {
        parts.push(`→ ${toolUseBlocks.join(", ")}`);
      }

      if (toolResultBlocks.length > 0) {
        const text = toolResultBlocks.join(" ");
        const preview = text.length > 25 ? text.slice(0, 25) + "..." : text;
        parts.push(`"${preview}"`);
      }

      const preview = parts.length > 0 ? parts.join(" ") : "(empty)";
      return `[${role}] ${preview}`;
    }
    return null;
  };

  const preview = getPreview();

  // Look up token count for this component from byComponent map
  const tokenEstimate =
    tokenSummary?.byComponent?.[node.id] ??
    tokenSummary?.byComponent?.[`section:${node.props?.id}`] ??
    tokenSummary?.byComponent?.[`tool:${node.props?.name}`];

  return (
    <div className="tree-node-container">
      <div
        className={`tree-node ${isSelected ? "selected" : ""} ${isComponent ? "component" : ""} ${isIntrinsic ? "intrinsic" : ""}`}
        style={{ paddingLeft: depth * 16 + 4 }}
        onClick={() => selectNode(node.id)}
      >
        {/* Expand toggle */}
        <span
          className={`tree-toggle ${!hasChildren ? "empty" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) toggleNode(node.id);
          }}
        >
          {hasChildren ? (isExpanded ? "\u25BC" : "\u25B6") : " "}
        </span>

        {/* Component name */}
        <span className={`tree-type ${isComponent ? "component" : "intrinsic"}`}>
          &lt;{node.type}&gt;
        </span>

        {/* Key badge */}
        {node.key && <span className="tree-key">key="{node.key}"</span>}

        {/* Preview text */}
        {preview && <span className="tree-preview">{preview}</span>}

        {/* Hooks badge */}
        {hasHooks && (
          <span className="tree-hooks-badge">
            {node.hooks.length} hook{node.hooks.length !== 1 ? "s" : ""}
          </span>
        )}

        {/* Token badge (only for significant components) */}
        {isComponent && tokenEstimate && tokenEstimate > 10 && (
          <span className="tree-token-badge" title={`~${tokenEstimate} tokens`}>
            {formatTokens(tokenEstimate)}
          </span>
        )}
      </div>

      {/* Children */}
      {isExpanded && hasChildren && (
        <div className="tree-children">
          {node.children.map((child) => (
            <TreeNode key={child.id} node={child} depth={depth + 1} tokenSummary={tokenSummary} />
          ))}
        </div>
      )}
    </div>
  );
}
