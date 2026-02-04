import { useState, useMemo, useEffect, useCallback } from "react";
import { useDevToolsEvents, type FiberNode, type TokenSummary } from "./hooks/useDevToolsEvents";
import { ExecutionList } from "./components/ExecutionList";
import { SessionList } from "./components/SessionList";
import { ContentPanel } from "./components/ContentPanel";
import { Inspector } from "./components/Inspector";
import { TickNavigator } from "./components/TickNavigator";
import { NetworkPanel } from "./components/NetworkPanel";
import { Splitter } from "./components/Splitter";

type SidebarTab = "executions" | "sessions";
type ContentTab = "execution" | "context" | "fiber" | "tools";
type GlobalTab = "network";

// Min/max widths for panels
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 500;
const INSPECTOR_MIN = 200;
const INSPECTOR_MAX = 600;

export function App() {
  const { executions, sessions, isConnected, clearAll, clients, gatewaySessions, requests } =
    useDevToolsEvents();
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("executions");
  const [contentTab, setContentTab] = useState<ContentTab>("execution");
  const [globalTab, setGlobalTab] = useState<GlobalTab | null>(null);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedTick, setSelectedTick] = useState<number | "latest">("latest");

  // Panel sizing
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [inspectorWidth, setInspectorWidth] = useState(320);

  const handleSidebarResize = useCallback((delta: number) => {
    setSidebarWidth((w) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w + delta)));
  }, []);

  const handleInspectorResize = useCallback((delta: number) => {
    // Note: delta is negative when dragging left (making inspector wider)
    setInspectorWidth((w) => Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, w - delta)));
  }, []);

  const selectedExecution = executions.find((e) => e.id === selectedExecutionId);
  const selectedSession = sessions.find((s) => s.id === selectedSessionId);

  // Filter executions based on search
  const filteredExecutions = useMemo(() => {
    if (!searchQuery.trim()) return executions;
    const query = searchQuery.toLowerCase();
    return executions.filter(
      (e) =>
        e.rootComponent.toLowerCase().includes(query) ||
        e.id.toLowerCase().includes(query) ||
        e.status.includes(query),
    );
  }, [executions, searchQuery]);

  const handleSessionSelect = (sessionId: string) => {
    setSelectedSessionId(sessionId);
    setSelectedExecutionId(null);
  };

  const handleExecutionSelect = (executionId: string) => {
    setSelectedExecutionId(executionId);
    setSelectedSessionId(null);
  };

  // Count tool calls only (not results) for badge
  const toolCount =
    selectedExecution?.ticks.flatMap((t) => t.events.filter((e) => e.type === "tool_call"))
      .length ?? 0;

  // Aggregate stats for header
  const runningCount = executions.filter((e) => e.status === "running").length;
  const totalTokens = executions.reduce((sum, e) => {
    const usage =
      e.totalUsage ??
      e.ticks.reduce(
        (acc, t) => ({
          inputTokens: acc.inputTokens + (t.usage?.inputTokens ?? 0),
          outputTokens: acc.outputTokens + (t.usage?.outputTokens ?? 0),
          totalTokens: acc.totalTokens + (t.usage?.totalTokens ?? 0),
        }),
        { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      );
    return sum + usage.totalTokens;
  }, 0);

  // Get fiber data for the selected tick (for Inspector panel)
  const getFiberData = (): {
    fiberTree: FiberNode | null;
    tokenSummary: TokenSummary | undefined;
  } => {
    if (!selectedExecution) {
      return { fiberTree: null, tokenSummary: undefined };
    }
    if (selectedTick === "latest") {
      const latestTick = selectedExecution.ticks[selectedExecution.ticks.length - 1];
      return {
        fiberTree: selectedSession?.latestFiberTree ?? selectedExecution.fiberTree ?? null,
        tokenSummary: latestTick?.tokenSummary,
      };
    }
    const tick = selectedExecution.ticks.find((t) => t.number === selectedTick);
    return {
      fiberTree: tick?.fiberTree ?? null,
      tokenSummary: tick?.tokenSummary,
    };
  };

  const { fiberTree, tokenSummary } = getFiberData();

  // Find selected node in tree
  const findNode = (tree: FiberNode | null, id: string): FiberNode | null => {
    if (!tree) return null;
    if (tree.id === id) return tree;
    for (const child of tree.children) {
      const found = findNode(child, id);
      if (found) return found;
    }
    return null;
  };

  const selectedNode = selectedNodeId ? findNode(fiberTree, selectedNodeId) : null;

  // Show inspector only when on fiber tab with an execution selected (and no global tab)
  const showInspector = selectedExecution && contentTab === "fiber" && !globalTab;

  // Clear node selection when switching away from fiber tab
  useEffect(() => {
    if (contentTab !== "fiber" || globalTab) {
      setSelectedNodeId(null);
    }
  }, [contentTab, globalTab]);

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <div className="header-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
            Tentickle DevTools
          </div>
        </div>
        <div className="header-status">
          {executions.length > 0 && (
            <div className="header-stats">
              {runningCount > 0 && (
                <span className="header-stat running">
                  <span className="header-stat-dot" />
                  {runningCount} running
                </span>
              )}
              <span className="header-stat">
                {executions.length} exec{executions.length !== 1 ? "s" : ""}
              </span>
              <span className="header-stat">{totalTokens.toLocaleString()} tokens</span>
            </div>
          )}
          <div className="status-indicator">
            <span className={`status-dot ${isConnected ? "connected" : ""}`} />
            <span>{isConnected ? "Connected" : "Disconnected"}</span>
          </div>
          <button className="btn btn-danger" onClick={clearAll}>
            Clear All
          </button>
        </div>
      </header>

      {/* Main Layout */}
      <main className="main">
        {/* Sidebar */}
        <aside className="sidebar" style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
          {/* Sidebar Tabs */}
          <div className="sidebar-tabs">
            <button
              className={`sidebar-tab ${sidebarTab === "executions" ? "active" : ""}`}
              onClick={() => setSidebarTab("executions")}
            >
              Executions ({executions.length})
            </button>
            <button
              className={`sidebar-tab ${sidebarTab === "sessions" ? "active" : ""}`}
              onClick={() => setSidebarTab("sessions")}
            >
              Sessions ({sessions.length})
            </button>
          </div>

          {/* Search Box */}
          <div className="search-box">
            <div className="search-wrapper">
              <span className="search-icon">🔍</span>
              <input
                type="text"
                className="search-input"
                placeholder="Search executions..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          </div>

          {/* Sidebar Content */}
          <div className="sidebar-content">
            {sidebarTab === "executions" ? (
              <ExecutionList
                executions={filteredExecutions}
                selectedId={selectedExecutionId}
                onSelect={handleExecutionSelect}
              />
            ) : (
              <SessionList
                sessions={sessions}
                executions={executions}
                selectedSessionId={selectedSessionId}
                selectedExecutionId={selectedExecutionId}
                onSelectSession={handleSessionSelect}
                onSelectExecution={handleExecutionSelect}
              />
            )}
          </div>
        </aside>

        {/* Sidebar Splitter */}
        <Splitter direction="horizontal" onResize={handleSidebarResize} />

        {/* Content */}
        <section className="content">
          {/* Tick Navigator - Always visible when execution is selected */}
          {selectedExecution && selectedExecution.ticks.some((t) => t.fiberTree) && (
            <div className="content-tick-navigator">
              <TickNavigator
                ticks={selectedExecution.ticks}
                selectedTick={selectedTick}
                onSelectTick={setSelectedTick}
              />
            </div>
          )}

          {/* Content Tabs - Two groups: Execution-scoped and Global */}
          <div className="content-tabs">
            {/* Execution-scoped tabs */}
            <div className="content-tabs-group">
              <button
                className={`content-tab ${contentTab === "execution" && !globalTab ? "active" : ""}`}
                onClick={() => {
                  setContentTab("execution");
                  setGlobalTab(null);
                }}
              >
                Execution
              </button>
              <button
                className={`content-tab ${contentTab === "context" && !globalTab ? "active" : ""}`}
                onClick={() => {
                  setContentTab("context");
                  setGlobalTab(null);
                }}
              >
                Context
              </button>
              <button
                className={`content-tab ${contentTab === "fiber" && !globalTab ? "active" : ""}`}
                onClick={() => {
                  setContentTab("fiber");
                  setGlobalTab(null);
                }}
              >
                Fiber Tree
              </button>
              <button
                className={`content-tab ${contentTab === "tools" && !globalTab ? "active" : ""}`}
                onClick={() => {
                  setContentTab("tools");
                  setGlobalTab(null);
                }}
              >
                Tools
                {toolCount > 0 && <span className="content-tab-badge">{toolCount}</span>}
              </button>
            </div>
            {/* Separator */}
            <div className="content-tabs-separator" />
            {/* Global tabs */}
            <div className="content-tabs-group">
              <button
                className={`content-tab ${globalTab === "network" ? "active" : ""}`}
                onClick={() => setGlobalTab("network")}
              >
                Network
                {clients.length > 0 && <span className="content-tab-badge">{clients.length}</span>}
              </button>
            </div>
          </div>

          {/* Content Body */}
          <div className="content-body">
            {globalTab === "network" ? (
              <NetworkPanel
                clients={clients}
                gatewaySessions={gatewaySessions}
                requests={requests}
              />
            ) : (
              <ContentPanel
                tab={contentTab}
                execution={selectedExecution}
                session={selectedSession}
                allExecutions={executions}
                selectedTick={selectedTick}
                onSelectTick={setSelectedTick}
                selectedNodeId={selectedNodeId}
                onNodeSelect={setSelectedNodeId}
              />
            )}
          </div>
        </section>

        {/* Inspector Panel - Right side */}
        {showInspector && (
          <>
            <Splitter direction="horizontal" onResize={handleInspectorResize} />
            <aside
              className="inspector-panel"
              style={{ width: inspectorWidth, minWidth: inspectorWidth }}
            >
              <Inspector node={selectedNode} tokenSummary={tokenSummary} />
            </aside>
          </>
        )}
      </main>
    </div>
  );
}
