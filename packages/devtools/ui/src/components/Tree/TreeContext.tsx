import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";

interface TreeContextValue {
  expandedNodes: Set<string>;
  selectedNodeId: string | null;
  toggleNode: (nodeId: string) => void;
  selectNode: (nodeId: string) => void;
  expandAll: (getAllIds: () => string[]) => void;
  collapseAll: () => void;
}

const TreeContext = createContext<TreeContextValue | null>(null);

export function useTreeContext(): TreeContextValue {
  const ctx = useContext(TreeContext);
  if (!ctx) {
    throw new Error("useTreeContext must be used within TreeProvider");
  }
  return ctx;
}

interface TreeProviderProps {
  children: ReactNode;
  selectedNodeId?: string | null;
  onNodeSelect?: (nodeId: string) => void;
}

export function TreeProvider({
  children,
  selectedNodeId: controlledSelectedNodeId,
  onNodeSelect,
}: TreeProviderProps) {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set(["root"]));
  const [internalSelectedNodeId, setInternalSelectedNodeId] = useState<string | null>(null);

  // Use controlled selection if provided, otherwise use internal state
  const isControlled = controlledSelectedNodeId !== undefined;
  const selectedNodeId = isControlled ? controlledSelectedNodeId : internalSelectedNodeId;

  const toggleNode = useCallback((nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  const selectNode = useCallback(
    (nodeId: string) => {
      if (onNodeSelect) {
        onNodeSelect(nodeId);
      } else {
        setInternalSelectedNodeId(nodeId);
      }
    },
    [onNodeSelect],
  );

  const expandAll = useCallback((getAllIds: () => string[]) => {
    setExpandedNodes(new Set(getAllIds()));
  }, []);

  const collapseAll = useCallback(() => {
    setExpandedNodes(new Set(["root"]));
  }, []);

  return (
    <TreeContext.Provider
      value={{ expandedNodes, selectedNodeId, toggleNode, selectNode, expandAll, collapseAll }}
    >
      {children}
    </TreeContext.Provider>
  );
}
