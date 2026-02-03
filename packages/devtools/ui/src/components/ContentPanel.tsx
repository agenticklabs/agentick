import { useState } from "react";
import type { Execution, Session, Tick, FiberNode, TokenSummary } from "../hooks/useDevToolsEvents";
import { Tree } from "./Tree";

type ContentTab = "execution" | "context" | "fiber" | "tools";

interface ContentPanelProps {
  tab: ContentTab;
  execution?: Execution;
  session?: Session;
  allExecutions: Execution[];
  selectedTick?: number | "latest";
  onSelectTick?: (tick: number | "latest") => void;
  selectedNodeId?: string | null;
  onNodeSelect?: (nodeId: string) => void;
}

export function ContentPanel({
  tab,
  execution,
  session,
  allExecutions,
  selectedTick = "latest",
  onSelectTick,
  selectedNodeId = null,
  onNodeSelect,
}: ContentPanelProps) {
  if (!execution && !session && tab !== "execution") {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">👈</div>
        <div className="empty-state-title">Select an execution</div>
        <div className="empty-state-text">
          Choose an execution from the sidebar to inspect its details
        </div>
      </div>
    );
  }

  switch (tab) {
    case "execution":
      return (
        <ExecutionView execution={execution} session={session} allExecutions={allExecutions} />
      );
    case "context":
      return <ContextView execution={execution} selectedTick={selectedTick} />;
    case "fiber":
      return (
        <FiberView
          execution={execution}
          session={session}
          selectedTick={selectedTick}
          onSelectTick={onSelectTick}
          selectedNodeId={selectedNodeId}
          onNodeSelect={onNodeSelect}
        />
      );
    case "tools":
      return <ToolsView execution={execution} />;
    default:
      return null;
  }
}

// ============================================================================
// Execution View (formerly Overview)
// ============================================================================

function ExecutionView({
  execution,
  session,
  allExecutions,
}: {
  execution?: Execution;
  session?: Session;
  allExecutions: Execution[];
}) {
  // Selected execution stats
  const execTokens =
    execution?.totalUsage?.totalTokens ??
    execution?.ticks.reduce((sum, t) => sum + (t.usage?.totalTokens ?? 0), 0) ??
    0;
  const execInputTokens =
    execution?.totalUsage?.inputTokens ??
    execution?.ticks.reduce((sum, t) => sum + (t.usage?.inputTokens ?? 0), 0) ??
    0;
  const execOutputTokens =
    execution?.totalUsage?.outputTokens ??
    execution?.ticks.reduce((sum, t) => sum + (t.usage?.outputTokens ?? 0), 0) ??
    0;

  // Get duration
  const duration = execution?.endTime
    ? ((execution.endTime - execution.startTime) / 1000).toFixed(2)
    : null;

  if (!execution) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">👈</div>
        <div className="empty-state-title">Select an execution</div>
        <div className="empty-state-text">
          Choose an execution from the sidebar to see detailed metrics
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Selected Execution Details - Primary focus */}
      <div className="overview-grid">
        <div className="overview-card">
          <div className="overview-card-label">Status</div>
          <div
            className={`overview-card-value ${execution.status === "completed" ? "green" : execution.status === "error" ? "red" : "yellow"}`}
          >
            {execution.status}
          </div>
          <div className="overview-card-detail">
            {duration ? `Duration: ${duration}s` : "In progress..."}
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-label">Ticks</div>
          <div className="overview-card-value blue">{execution.ticks.length}</div>
          <div className="overview-card-detail">Model iterations</div>
        </div>
        <div className="overview-card">
          <div className="overview-card-label">Tokens</div>
          <div className="overview-card-value yellow">{execTokens.toLocaleString()}</div>
          <div className="overview-card-detail">
            {execInputTokens.toLocaleString()} in / {execOutputTokens.toLocaleString()} out
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-label">Model</div>
          <div className="overview-card-value purple" style={{ fontSize: 16 }}>
            {execution.ticks[0]?.model || "—"}
          </div>
          <div className="overview-card-detail">Provider model</div>
        </div>
      </div>

      {/* Fiber Summary */}
      {execution.fiberSummary && (
        <>
          <h3
            style={{
              fontSize: 14,
              marginTop: 24,
              marginBottom: 12,
              color: "var(--text-secondary)",
            }}
          >
            Component Tree
          </h3>
          <div className="overview-grid">
            <div className="overview-card">
              <div className="overview-card-label">Components</div>
              <div className="overview-card-value purple">
                {execution.fiberSummary.componentCount}
              </div>
            </div>
            <div className="overview-card">
              <div className="overview-card-label">Hooks</div>
              <div className="overview-card-value blue">{execution.fiberSummary.hookCount}</div>
              <div className="overview-card-detail">
                {Object.entries(execution.fiberSummary.hooksByType || {})
                  .map(([type, count]) => `${type}: ${count}`)
                  .join(", ")}
              </div>
            </div>
          </div>
        </>
      )}

      {/* Execution ID */}
      <div style={{ marginTop: 24, fontSize: 11, color: "var(--text-muted)" }}>
        <strong>Execution ID:</strong> {execution.id}
        {execution.sessionId && (
          <span style={{ marginLeft: 16 }}>
            <strong>Session:</strong> {execution.sessionId.slice(0, 16)}...
          </span>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Context View - Shows per-tick context based on selected tick
// ============================================================================

function ContextView({
  execution,
  selectedTick = "latest",
}: {
  execution?: Execution;
  selectedTick?: number | "latest";
}) {
  const [compiledExpanded, setCompiledExpanded] = useState(true);
  const [providerInputExpanded, setProviderInputExpanded] = useState(true);
  const [providerResponseExpanded, setProviderResponseExpanded] = useState(true);
  const [modelOutputExpanded, setModelOutputExpanded] = useState(true);
  const [comOutputExpanded, setComOutputExpanded] = useState(true);

  if (!execution) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📝</div>
        <div className="empty-state-title">Select an execution</div>
        <div className="empty-state-text">
          Choose an execution from the sidebar to inspect its context
        </div>
      </div>
    );
  }

  if (execution.ticks.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">⏳</div>
        <div className="empty-state-title">No ticks yet</div>
        <div className="empty-state-text">Context will appear as the model processes</div>
      </div>
    );
  }

  // Get the selected tick
  const tick =
    selectedTick === "latest"
      ? execution.ticks[execution.ticks.length - 1]
      : execution.ticks.find((t) => t.number === selectedTick);

  if (!tick) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">❓</div>
        <div className="empty-state-title">Tick not found</div>
        <div className="empty-state-text">Selected tick does not exist</div>
      </div>
    );
  }

  const tokens = tick.usage?.totalTokens ?? 0;
  const inputTokens = tick.usage?.inputTokens ?? 0;
  const outputTokens = tick.usage?.outputTokens ?? 0;
  const duration = tick.endTime ? tick.endTime - tick.startTime : 0;
  const isRunning = !tick.endTime;

  return (
    <div className="context-view">
      {/* Tick Summary Header */}
      <div className="context-header">
        <div className="context-header-title">
          <span className="context-header-tick">Tick {tick.number}</span>
          <span className={`context-header-status ${isRunning ? "running" : "completed"}`}>
            {isRunning ? "Running" : "Complete"}
          </span>
        </div>
        <div className="context-header-stats">
          <span className="context-stat">
            <span className="context-stat-icon">🤖</span>
            {tick.model || "—"}
          </span>
          <span className="context-stat">
            <span className="context-stat-icon">📊</span>
            {tokens.toLocaleString()} tokens ({inputTokens.toLocaleString()} in /{" "}
            {outputTokens.toLocaleString()} out)
          </span>
          <span className="context-stat">
            <span className="context-stat-icon">⏱️</span>
            {duration}ms
          </span>
        </div>
      </div>

      {/* Response Content (if any) */}
      {tick.content && (
        <div className="context-section">
          <div className="context-section-header">
            <span className="context-section-icon">💬</span>
            Response
          </div>
          <div className="context-section-body">
            <div className="tick-content">{tick.content}</div>
          </div>
        </div>
      )}

      {/* 1. Compiled Context - What we rendered */}
      {tick.compiled && (
        <div className="context-section collapsible">
          <div
            className="context-section-header clickable"
            onClick={() => setCompiledExpanded(!compiledExpanded)}
          >
            <span className={`context-section-expand ${compiledExpanded ? "expanded" : ""}`}>
              ▶
            </span>
            <span className="context-section-icon">📝</span>
            Compiled Context
            <span className="context-section-count">
              {tick.compiled.messages?.length ?? 0} messages, {tick.compiled.tools?.length ?? 0}{" "}
              tools
            </span>
          </div>
          {compiledExpanded && (
            <div className="context-section-body">
              {/* System Prompt */}
              {tick.compiled.system && (
                <div className="context-subsection">
                  <div className="context-subsection-label">System Prompt</div>
                  <pre className="json-view" style={{ maxHeight: 200 }}>
                    {tick.compiled.system}
                  </pre>
                </div>
              )}
              {/* Messages */}
              {tick.compiled.messages && tick.compiled.messages.length > 0 && (
                <div className="context-subsection">
                  <div className="context-subsection-label">
                    Messages ({tick.compiled.messages.length})
                  </div>
                  <pre className="json-view" style={{ maxHeight: 300 }}>
                    {JSON.stringify(tick.compiled.messages, null, 2)}
                  </pre>
                </div>
              )}
              {/* Tools */}
              {tick.compiled.tools && tick.compiled.tools.length > 0 && (
                <div className="context-subsection">
                  <div className="context-subsection-label">
                    Tools ({tick.compiled.tools.length})
                  </div>
                  <pre className="json-view" style={{ maxHeight: 200 }}>
                    {JSON.stringify(tick.compiled.tools, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 2. Provider Input - What the provider model actually sees */}
      {tick.modelRequest && (
        <div className="context-section collapsible">
          <div
            className="context-section-header clickable"
            onClick={() => setProviderInputExpanded(!providerInputExpanded)}
          >
            <span className={`context-section-expand ${providerInputExpanded ? "expanded" : ""}`}>
              ▶
            </span>
            <span className="context-section-icon">📤</span>
            Provider Input
            <span className="context-section-count">{tick.model || "model"}</span>
          </div>
          {providerInputExpanded && (
            <div className="context-section-body">
              <pre className="json-view" style={{ maxHeight: 400 }}>
                {JSON.stringify(tick.modelRequest, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* 3. Provider Response - Raw response from provider */}
      {tick.providerResponse && (
        <div className="context-section collapsible">
          <div
            className="context-section-header clickable"
            onClick={() => setProviderResponseExpanded(!providerResponseExpanded)}
          >
            <span
              className={`context-section-expand ${providerResponseExpanded ? "expanded" : ""}`}
            >
              ▶
            </span>
            <span className="context-section-icon">📥</span>
            Provider Response (Raw)
          </div>
          {providerResponseExpanded && (
            <div className="context-section-body">
              <pre className="json-view" style={{ maxHeight: 400 }}>
                {JSON.stringify(tick.providerResponse, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* 4. Model Output - Transformed to ModelOutput */}
      {tick.modelOutput && (
        <div className="context-section collapsible">
          <div
            className="context-section-header clickable"
            onClick={() => setModelOutputExpanded(!modelOutputExpanded)}
          >
            <span className={`context-section-expand ${modelOutputExpanded ? "expanded" : ""}`}>
              ▶
            </span>
            <span className="context-section-icon">🔄</span>
            Model Output (Transformed)
          </div>
          {modelOutputExpanded && (
            <div className="context-section-body">
              <pre className="json-view" style={{ maxHeight: 400 }}>
                {JSON.stringify(tick.modelOutput, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* 5. COM Output - Final output from COM layer */}
      {tick.comOutput && (
        <div className="context-section collapsible">
          <div
            className="context-section-header clickable"
            onClick={() => setComOutputExpanded(!comOutputExpanded)}
          >
            <span className={`context-section-expand ${comOutputExpanded ? "expanded" : ""}`}>
              ▶
            </span>
            <span className="context-section-icon">✨</span>
            COM Output
          </div>
          {comOutputExpanded && (
            <div className="context-section-body">
              <pre className="json-view" style={{ maxHeight: 400 }}>
                {JSON.stringify(tick.comOutput, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Tool Calls for this tick */}
      {(() => {
        const toolCalls = tick.events.filter((e) => e.type === "tool_call");
        const toolResults = tick.events.filter((e) => e.type === "tool_result");
        if (toolCalls.length === 0) return null;
        return (
          <div className="context-section">
            <div className="context-section-header">
              <span className="context-section-icon">🔧</span>
              Tool Calls ({toolCalls.length})
            </div>
            <div className="context-section-body">
              <div className="tick-timeline">
                {toolCalls.map((event, i) => {
                  const data = event.data as any;
                  const result = toolResults.find(
                    (r: any) => (r.data as any)?.toolUseId === data?.toolUseId,
                  );
                  return (
                    <div key={i} className="tick-event">
                      <span className="tick-event-type tool_call">
                        {data?.toolName || data?.name || "tool_call"}
                      </span>
                      <div className="tick-event-content">
                        <pre className="json-view" style={{ margin: 0, maxHeight: 150 }}>
                          {JSON.stringify(data?.input || data, null, 2)}
                        </pre>
                        {result && (
                          <div style={{ marginTop: 8 }}>
                            <span style={{ color: "var(--accent-green)", fontSize: 11 }}>
                              Result:
                            </span>
                            <pre
                              className="json-view"
                              style={{ margin: "4px 0 0 0", maxHeight: 150 }}
                            >
                              {JSON.stringify(
                                (result.data as any)?.result ||
                                  (result.data as any)?.content ||
                                  result.data,
                                null,
                                2,
                              )}
                            </pre>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// Minimal fiber tree display for tick details
function TickFiberTree({
  fiberTree,
  expandedNodes,
  setExpandedNodes,
}: {
  fiberTree: FiberNode;
  expandedNodes: Set<string>;
  setExpandedNodes: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  const toggleNode = (id: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="tick-fiber-tree">
      <TickFiberNode node={fiberTree} expandedNodes={expandedNodes} onToggle={toggleNode} />
    </div>
  );
}

function TickFiberNode({
  node,
  expandedNodes,
  onToggle,
}: {
  node: FiberNode;
  expandedNodes: Set<string>;
  onToggle: (id: string) => void;
}) {
  // Skip fragment nodes
  if (node.type === "tentickle.fragment") {
    return (
      <>
        {node.children.map((child) => (
          <TickFiberNode
            key={child.id}
            node={child}
            expandedNodes={expandedNodes}
            onToggle={onToggle}
          />
        ))}
      </>
    );
  }

  const hasChildren = node.children.length > 0;
  const hasHooks = node.hooks.length > 0;
  const isExpanded = expandedNodes.has(node.id);
  const isHostElement = node.type.startsWith("tentickle.") || node.type === "text";

  return (
    <div className="fiber-node">
      <div className="fiber-node-row">
        <span
          className={`fiber-expand-btn ${isExpanded ? "expanded" : ""} ${!hasChildren ? "empty" : ""}`}
          onClick={() => hasChildren && onToggle(node.id)}
        >
          ▶
        </span>
        <span className={`fiber-type ${isHostElement ? "host" : ""}`}>&lt;{node.type}&gt;</span>
        {node.key && <span className="fiber-key">key="{node.key}"</span>}
        {hasHooks && (
          <span className="fiber-hooks-badge">
            {node.hooks.length} hook{node.hooks.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>
      {hasChildren && isExpanded && (
        <div className="fiber-children">
          {node.children.map((child) => (
            <TickFiberNode
              key={child.id}
              node={child}
              expandedNodes={expandedNodes}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Fiber View (Enhanced with Tree panel - Inspector is now in main layout)
// ============================================================================

interface FiberViewProps {
  execution?: Execution;
  session?: Session;
  selectedTick?: number | "latest";
  onSelectTick?: (tick: number | "latest") => void;
  selectedNodeId?: string | null;
  onNodeSelect?: (nodeId: string) => void;
}

function FiberView({
  execution,
  session,
  selectedTick = "latest",
  onSelectTick,
  selectedNodeId = null,
  onNodeSelect,
}: FiberViewProps) {
  // Get ticks with fiber trees
  const ticksWithFiber = execution?.ticks.filter((t) => t.fiberTree) ?? [];

  // Determine which fiber tree to show
  const getSelectedFiberData = (): {
    fiberTree: FiberNode | null;
    summary:
      | { componentCount: number; hookCount: number; hooksByType?: Record<string, number> }
      | undefined;
    tokenSummary: TokenSummary | undefined;
  } => {
    if (selectedTick === "latest") {
      const latestTick = execution?.ticks[execution.ticks.length - 1];
      return {
        fiberTree: session?.latestFiberTree ?? execution?.fiberTree ?? null,
        summary: session?.latestFiberSummary ?? execution?.fiberSummary,
        tokenSummary: latestTick?.tokenSummary,
      };
    }
    const tick = execution?.ticks.find((t) => t.number === selectedTick);
    return {
      fiberTree: tick?.fiberTree ?? null,
      summary: tick?.fiberSummary,
      tokenSummary: tick?.tokenSummary,
    };
  };

  const { fiberTree, summary, tokenSummary } = getSelectedFiberData();

  if (!fiberTree && ticksWithFiber.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">🌲</div>
        <div className="empty-state-title">No fiber tree available</div>
        <div className="empty-state-text">
          Fiber snapshots are captured after each tick completes
        </div>
      </div>
    );
  }

  // Handle node selection - call parent callback if provided
  const handleNodeSelect = (nodeId: string) => {
    if (onNodeSelect) {
      onNodeSelect(nodeId);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 16 }}>
      {/* Summary */}
      {summary && (
        <div className="fiber-tree-summary">
          <div className="fiber-tree-summary-item">
            <span className="fiber-tree-summary-value">{summary.componentCount}</span>
            <span className="fiber-tree-summary-label">Components</span>
          </div>
          <div className="fiber-tree-summary-item">
            <span className="fiber-tree-summary-value">{summary.hookCount}</span>
            <span className="fiber-tree-summary-label">Hooks</span>
          </div>
          {tokenSummary && (
            <div className="fiber-tree-summary-item">
              <span className="fiber-tree-summary-value">
                ~
                {tokenSummary.total < 1000
                  ? tokenSummary.total
                  : `${(tokenSummary.total / 1000).toFixed(1)}k`}
              </span>
              <span className="fiber-tree-summary-label">Tokens</span>
            </div>
          )}
          {Object.entries(summary.hooksByType || {}).map(([type, count]) => (
            <div key={type} className="fiber-tree-summary-item">
              <span className="fiber-tree-summary-value">{count}</span>
              <span className="fiber-tree-summary-label">{type}</span>
            </div>
          ))}
        </div>
      )}

      {/* Tree Panel - Full width since Inspector is now in main layout */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <Tree
          fiberTree={fiberTree}
          tokenSummary={tokenSummary}
          selectedNodeId={selectedNodeId}
          onNodeSelect={handleNodeSelect}
        />
      </div>
    </div>
  );
}

// ============================================================================
// Tools View
// ============================================================================

function ToolsView({ execution }: { execution?: Execution }) {
  if (!execution) {
    return <div className="empty-state">Select an execution to view tools</div>;
  }

  // Group tool calls with their results
  const toolEvents: Array<{
    call: any;
    result?: any;
    tick: number;
  }> = [];

  execution.ticks.forEach((tick) => {
    const calls = tick.events.filter((e) => e.type === "tool_call");
    const results = tick.events.filter((e) => e.type === "tool_result");

    calls.forEach((call) => {
      const callData = call.data as any;
      const result = results.find((r) => (r.data as any)?.toolUseId === callData?.toolUseId);
      toolEvents.push({
        call: callData,
        result: result?.data,
        tick: tick.number,
      });
    });
  });

  if (toolEvents.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">🔧</div>
        <div className="empty-state-title">No tool calls</div>
        <div className="empty-state-text">
          Tool calls will appear here when the model uses tools
        </div>
      </div>
    );
  }

  return (
    <div>
      {toolEvents.map((event, i) => (
        <div key={i} className="tool-call-card">
          <div className="tool-call-header">
            <div
              className={`tool-call-icon ${event.result ? (event.result.isError ? "error" : "success") : "call"}`}
            >
              {event.result ? (event.result.isError ? "❌" : "✓") : "🔧"}
            </div>
            <div className="tool-call-info">
              <div className="tool-call-name">
                {event.call?.toolName || event.call?.name || "Unknown Tool"}
              </div>
              <div className="tool-call-id">{event.call?.toolUseId?.slice(0, 16)}...</div>
            </div>
            <div className="tool-call-meta">
              <div className="tool-call-tick">Tick {event.tick}</div>
            </div>
          </div>
          <div className="tool-call-body">
            <div className="tool-call-section">
              <div className="tool-call-section-label">Input</div>
              <pre className="json-view">{JSON.stringify(event.call?.input || {}, null, 2)}</pre>
            </div>
            {event.result && (
              <div className="tool-call-section">
                <div className="tool-call-section-label">
                  {event.result.isError ? "Error" : "Result"}
                </div>
                <pre className="json-view">
                  {JSON.stringify(
                    event.result.result || event.result.content || event.result,
                    null,
                    2,
                  )}
                </pre>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
