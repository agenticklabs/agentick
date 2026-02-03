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
    if (node.type === "text" && node.props.value) {
      const text = String(node.props.value);
      return text.length > 40 ? `"${text.slice(0, 40)}..."` : `"${text}"`;
    }
    if (node.props.text) {
      const text = String(node.props.text);
      return text.length > 40 ? `"${text.slice(0, 40)}..."` : `"${text}"`;
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
