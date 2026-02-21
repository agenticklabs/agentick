import { useState, useMemo, useCallback } from "react";
import type { FiberNode, TokenSummary } from "../../hooks/useDevToolsEvents.js";
import { TreeProvider, useTreeContext } from "./TreeContext.js";
import { TreeNode } from "./TreeNode.js";
import { TreeSearch } from "./TreeSearch.js";
import { formatTokens } from "../../utils/format.js";

interface TreeProps {
  fiberTree: FiberNode | null;
  tokenSummary?: TokenSummary;
  selectedNodeId?: string | null;
  onNodeSelect?: (nodeId: string) => void;
}

/**
 * Filter tree nodes that match the search query.
 * Returns a new tree with only matching nodes and their ancestors.
 */
function filterTree(node: FiberNode, query: string): FiberNode | null {
  const lowerQuery = query.toLowerCase();

  // Check if this node matches
  const typeMatches = node.type.toLowerCase().includes(lowerQuery);
  const keyMatches = node.key?.toString().toLowerCase().includes(lowerQuery);
  const summaryMatches = node._summary?.toLowerCase().includes(lowerQuery);

  // Filter children recursively
  const filteredChildren = node.children
    .map((child) => filterTree(child, query))
    .filter((child): child is FiberNode => child !== null);

  // Include this node if it matches or has matching children
  if (typeMatches || keyMatches || summaryMatches || filteredChildren.length > 0) {
    return {
      ...node,
      children: filteredChildren,
    };
  }

  return null;
}

/**
 * Collect all node IDs in the tree.
 */
function collectAllIds(node: FiberNode): string[] {
  const ids = [node.id];
  for (const child of node.children) {
    ids.push(...collectAllIds(child));
  }
  return ids;
}

function TreeContent({ fiberTree, tokenSummary }: Pick<TreeProps, "fiberTree" | "tokenSummary">) {
  const [searchQuery, setSearchQuery] = useState("");
  const { expandAll, collapseAll } = useTreeContext();

  const filteredTree = useMemo(() => {
    if (!fiberTree) return null;
    if (!searchQuery.trim()) return fiberTree;
    return filterTree(fiberTree, searchQuery);
  }, [fiberTree, searchQuery]);

  const handleExpandAll = useCallback(() => {
    if (fiberTree) {
      expandAll(() => collectAllIds(fiberTree));
    }
  }, [fiberTree, expandAll]);

  if (!fiberTree) {
    return (
      <div className="tree-empty">
        <div className="tree-empty-icon">&#127794;</div>
        <div className="tree-empty-title">No fiber tree</div>
        <div className="tree-empty-text">Component tree will appear here after execution</div>
      </div>
    );
  }

  return (
    <div className="tree-panel">
      <div className="tree-toolbar">
        <TreeSearch value={searchQuery} onChange={setSearchQuery} />
        <div className="tree-toolbar-buttons">
          <button className="btn btn-sm" onClick={handleExpandAll}>
            Expand All
          </button>
          <button className="btn btn-sm" onClick={collapseAll}>
            Collapse All
          </button>
        </div>
      </div>

      {/* Token summary bar */}
      {tokenSummary && (
        <div className="tree-token-summary">
          <span className="tree-token-total">~{formatTokens(tokenSummary.total)} total</span>
          <span className="tree-token-breakdown">
            System: {formatTokens(tokenSummary.system)} | Messages:{" "}
            {formatTokens(tokenSummary.messages)} | Tools: {formatTokens(tokenSummary.tools)}
            {tokenSummary.ephemeral > 0 && ` | Ephemeral: ${formatTokens(tokenSummary.ephemeral)}`}
          </span>
        </div>
      )}

      <div className="tree-content">
        {filteredTree ? (
          <TreeNode node={filteredTree} tokenSummary={tokenSummary} />
        ) : (
          <div className="tree-no-results">No matching components</div>
        )}
      </div>
    </div>
  );
}

export function Tree({ selectedNodeId, onNodeSelect, ...rest }: TreeProps) {
  return (
    <TreeProvider selectedNodeId={selectedNodeId} onNodeSelect={onNodeSelect}>
      <TreeContent {...rest} />
    </TreeProvider>
  );
}
