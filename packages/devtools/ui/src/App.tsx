import { useState, useMemo } from "react";
import { useDevToolsEvents, type Execution, type Session } from "./hooks/useDevToolsEvents";
import { ExecutionList } from "./components/ExecutionList";
import { SessionList } from "./components/SessionList";
import { ContentPanel } from "./components/ContentPanel";

type SidebarTab = "executions" | "sessions";
type ContentTab = "overview" | "ticks" | "fiber" | "tools";

export function App() {
  const { executions, sessions, isConnected, clearAll } = useDevToolsEvents();
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("executions");
  const [contentTab, setContentTab] = useState<ContentTab>("overview");
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

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
        <aside className="sidebar">
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

        {/* Content */}
        <section className="content">
          {/* Content Tabs */}
          <div className="content-tabs">
            <button
              className={`content-tab ${contentTab === "overview" ? "active" : ""}`}
              onClick={() => setContentTab("overview")}
            >
              Overview
            </button>
            <button
              className={`content-tab ${contentTab === "ticks" ? "active" : ""}`}
              onClick={() => setContentTab("ticks")}
            >
              Ticks
              {selectedExecution && (
                <span className="content-tab-badge">{selectedExecution.ticks.length}</span>
              )}
            </button>
            <button
              className={`content-tab ${contentTab === "fiber" ? "active" : ""}`}
              onClick={() => setContentTab("fiber")}
            >
              Fiber Tree
            </button>
            <button
              className={`content-tab ${contentTab === "tools" ? "active" : ""}`}
              onClick={() => setContentTab("tools")}
            >
              Tools
              {toolCount > 0 && <span className="content-tab-badge">{toolCount}</span>}
            </button>
          </div>

          {/* Content Body */}
          <div className="content-body">
            <ContentPanel
              tab={contentTab}
              execution={selectedExecution}
              session={selectedSession}
              allExecutions={executions}
            />
          </div>
        </section>
      </main>
    </div>
  );
}
