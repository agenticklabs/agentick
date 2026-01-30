import { useState } from "react";
import type { Execution, Session, Tick, FiberNode, HookState } from "../hooks/useDevToolsEvents";

type ContentTab = "overview" | "ticks" | "fiber" | "tools";

interface ContentPanelProps {
  tab: ContentTab;
  execution?: Execution;
  session?: Session;
  allExecutions: Execution[];
}

export function ContentPanel({ tab, execution, session, allExecutions }: ContentPanelProps) {
  if (!execution && !session && tab !== "overview") {
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
    case "overview":
      return <OverviewView execution={execution} session={session} allExecutions={allExecutions} />;
    case "ticks":
      return <TicksView execution={execution} />;
    case "fiber":
      return <FiberView execution={execution} session={session} />;
    case "tools":
      return <ToolsView execution={execution} />;
    default:
      return null;
  }
}

// ============================================================================
// Overview View
// ============================================================================

function OverviewView({
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
// Ticks View
// ============================================================================

function TicksView({ execution }: { execution?: Execution }) {
  const [expandedTicks, setExpandedTicks] = useState<Set<number>>(new Set());

  if (!execution) {
    return <div className="empty-state">Select an execution to view ticks</div>;
  }

  if (execution.ticks.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">⏳</div>
        <div className="empty-state-title">No ticks yet</div>
        <div className="empty-state-text">Ticks will appear as the model processes</div>
      </div>
    );
  }

  const toggleTick = (tickNum: number) => {
    setExpandedTicks((prev) => {
      const next = new Set(prev);
      if (next.has(tickNum)) {
        next.delete(tickNum);
      } else {
        next.add(tickNum);
      }
      return next;
    });
  };

  const expandAll = () => {
    setExpandedTicks(new Set(execution.ticks.map((t) => t.number)));
  };

  const collapseAll = () => {
    setExpandedTicks(new Set());
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button className="btn btn-sm" onClick={expandAll}>
          Expand All
        </button>
        <button className="btn btn-sm" onClick={collapseAll}>
          Collapse All
        </button>
      </div>
      {execution.ticks.map((tick) => (
        <TickCard
          key={tick.number}
          tick={tick}
          expanded={expandedTicks.has(tick.number)}
          onToggle={() => toggleTick(tick.number)}
        />
      ))}
    </div>
  );
}

function TickCard({
  tick,
  expanded,
  onToggle,
}: {
  tick: Tick;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [eventsExpanded, setEventsExpanded] = useState(false);
  const [contextExpanded, setContextExpanded] = useState(false);
  const [modelIOExpanded, setModelIOExpanded] = useState(false);
  const [fiberExpanded, setFiberExpanded] = useState(false);
  const [fiberExpandedNodes, setFiberExpandedNodes] = useState<Set<string>>(new Set(["fiber-0"]));

  const tokens = tick.usage?.totalTokens ?? 0;
  const inputTokens = tick.usage?.inputTokens ?? 0;
  const outputTokens = tick.usage?.outputTokens ?? 0;
  const duration = tick.endTime ? tick.endTime - tick.startTime : 0;
  const isRunning = !tick.endTime;

  const toolCalls = tick.events.filter((e) => e.type === "tool_call");
  const toolResults = tick.events.filter((e) => e.type === "tool_result");
  const nonDeltaEvents = tick.events.filter((e) => e.type !== "content_delta");

  return (
    <div className={`tick-card ${expanded ? "expanded" : ""}`}>
      <div className="tick-header" onClick={onToggle}>
        <span className={`tick-expand ${expanded ? "expanded" : ""}`}>▶</span>
        <span className="tick-number">Tick {tick.number}</span>
        <span className={`tick-status ${isRunning ? "running" : "completed"}`}>
          {isRunning ? "⏳ Running" : "✓ Complete"}
        </span>
        <div className="tick-stats">
          <span className="tick-stat" title="Model">
            <span className="tick-stat-icon">🤖</span>
            {tick.model || "—"}
          </span>
          <span className="tick-stat" title={`Input: ${inputTokens} / Output: ${outputTokens}`}>
            <span className="tick-stat-icon">📊</span>
            {tokens.toLocaleString()} tokens
          </span>
          <span className="tick-stat" title="Duration">
            <span className="tick-stat-icon">⏱️</span>
            {duration}ms
          </span>
          {toolCalls.length > 0 && (
            <span className="tick-stat" title="Tool calls">
              <span className="tick-stat-icon">🔧</span>
              {toolCalls.length} tool{toolCalls.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>

      {expanded && (
        <div className="tick-body">
          {/* Response Content */}
          {tick.content && (
            <div className="tick-section">
              <div className="tick-section-header">
                <span className="tick-section-header-icon">💬</span>
                Response
              </div>
              <div className="tick-content">{tick.content}</div>
            </div>
          )}

          {/* Tool Calls */}
          {toolCalls.length > 0 && (
            <div className="tick-section">
              <div className="tick-section-header">
                <span className="tick-section-header-icon">🔧</span>
                Tool Calls ({toolCalls.length})
              </div>
              <div className="tick-timeline">
                {toolCalls.map((event, i) => {
                  const data = event.data as any;
                  const result = toolResults.find(
                    (r: any) => (r.data as any)?.toolUseId === data?.toolUseId,
                  );
                  return (
                    <div key={i} className="tick-event">
                      <span className={`tick-event-type tool_call`}>
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
          )}

          {/* Context - Compiled Input (collapsible) */}
          {tick.compiled && (
            <div className="tick-section collapsible">
              <div
                className="tick-section-header clickable"
                onClick={() => setContextExpanded(!contextExpanded)}
              >
                <span className={`tick-section-expand ${contextExpanded ? "expanded" : ""}`}>
                  ▶
                </span>
                <span className="tick-section-header-icon">📝</span>
                Context
                <span className="tick-section-count">
                  {tick.compiled.messages?.length ?? 0} messages, {tick.compiled.tools?.length ?? 0}{" "}
                  tools
                </span>
              </div>
              {contextExpanded && (
                <div className="tick-section-body">
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

          {/* Model I/O - Request & Response (collapsible) */}
          {(tick.modelRequest || tick.providerResponse || tick.modelOutput) && (
            <div className="tick-section collapsible">
              <div
                className="tick-section-header clickable"
                onClick={() => setModelIOExpanded(!modelIOExpanded)}
              >
                <span className={`tick-section-expand ${modelIOExpanded ? "expanded" : ""}`}>
                  ▶
                </span>
                <span className="tick-section-header-icon">🔄</span>
                Model I/O
                <span className="tick-section-count">{tick.model || "model"}</span>
              </div>
              {modelIOExpanded && (
                <div className="tick-section-body">
                  {/* Model Request (Provider Input) */}
                  {tick.modelRequest && (
                    <div className="context-subsection">
                      <div className="context-subsection-label">Provider Request</div>
                      <pre className="json-view" style={{ maxHeight: 300 }}>
                        {JSON.stringify(tick.modelRequest, null, 2)}
                      </pre>
                    </div>
                  )}
                  {/* Provider Response (Raw) */}
                  {tick.providerResponse && (
                    <div className="context-subsection">
                      <div className="context-subsection-label">Provider Response (Raw)</div>
                      <pre className="json-view" style={{ maxHeight: 300 }}>
                        {JSON.stringify(tick.providerResponse, null, 2)}
                      </pre>
                    </div>
                  )}
                  {/* Model Output (Transformed) */}
                  {tick.modelOutput && (
                    <div className="context-subsection">
                      <div className="context-subsection-label">Transformed Output</div>
                      <pre className="json-view" style={{ maxHeight: 300 }}>
                        {JSON.stringify(tick.modelOutput, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Events Timeline (collapsible, collapsed by default) */}
          {nonDeltaEvents.length > 0 && (
            <div className="tick-section collapsible">
              <div
                className="tick-section-header clickable"
                onClick={() => setEventsExpanded(!eventsExpanded)}
              >
                <span className={`tick-section-expand ${eventsExpanded ? "expanded" : ""}`}>▶</span>
                <span className="tick-section-header-icon">📋</span>
                Events
                <span className="tick-section-count">{nonDeltaEvents.length}</span>
              </div>
              {eventsExpanded && (
                <div className="tick-timeline">
                  {nonDeltaEvents.slice(0, 50).map((event, i) => (
                    <div key={i} className="tick-event">
                      <span className="tick-event-time">+{event.timestamp - tick.startTime}ms</span>
                      <span className={`tick-event-type ${event.type}`}>{event.type}</span>
                      <span className="tick-event-content">
                        {typeof event.data === "object"
                          ? JSON.stringify(event.data).slice(0, 100)
                          : String(event.data).slice(0, 100)}
                      </span>
                    </div>
                  ))}
                  {nonDeltaEvents.length > 50 && (
                    <div style={{ padding: 8, color: "var(--text-muted)", fontSize: 11 }}>
                      ... and {nonDeltaEvents.length - 50} more events
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Fiber Tree Snapshot (collapsible) */}
          {tick.fiberTree && (
            <div className="tick-section collapsible">
              <div
                className="tick-section-header clickable"
                onClick={() => setFiberExpanded(!fiberExpanded)}
              >
                <span className={`tick-section-expand ${fiberExpanded ? "expanded" : ""}`}>▶</span>
                <span className="tick-section-header-icon">🌲</span>
                Fiber Tree
                {tick.fiberSummary && (
                  <span className="tick-section-count">
                    {tick.fiberSummary.componentCount} components, {tick.fiberSummary.hookCount}{" "}
                    hooks
                  </span>
                )}
              </div>
              {fiberExpanded && (
                <div className="tick-section-body">
                  <TickFiberTree
                    fiberTree={tick.fiberTree}
                    expandedNodes={fiberExpandedNodes}
                    setExpandedNodes={setFiberExpandedNodes}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}
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
// Fiber View
// ============================================================================

function FiberView({ execution, session }: { execution?: Execution; session?: Session }) {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set(["fiber-0"]));
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [showHooks, setShowHooks] = useState(true);
  const [showProps, setShowProps] = useState(false);
  const [selectedTick, setSelectedTick] = useState<number | "latest">("latest");

  // Get ticks with fiber trees
  const ticksWithFiber = execution?.ticks.filter((t) => t.fiberTree) ?? [];

  // Determine which fiber tree to show
  const getSelectedFiberData = () => {
    if (selectedTick === "latest") {
      return {
        fiberTree: session?.latestFiberTree ?? execution?.fiberTree,
        summary: session?.latestFiberSummary ?? execution?.fiberSummary,
      };
    }
    const tick = execution?.ticks.find((t) => t.number === selectedTick);
    return {
      fiberTree: tick?.fiberTree,
      summary: tick?.fiberSummary,
    };
  };

  const { fiberTree, summary } = getSelectedFiberData();

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

  const expandAll = () => {
    const allIds = new Set<string>();
    const collectIds = (node: FiberNode) => {
      allIds.add(node.id);
      node.children.forEach(collectIds);
    };
    collectIds(fiberTree);
    setExpandedNodes(allIds);
  };

  const collapseAll = () => {
    setExpandedNodes(new Set(["fiber-0"]));
  };

  return (
    <div>
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
          {Object.entries(summary.hooksByType || {}).map(([type, count]) => (
            <div key={type} className="fiber-tree-summary-item">
              <span className="fiber-tree-summary-value">{count}</span>
              <span className="fiber-tree-summary-label">{type}</span>
            </div>
          ))}
        </div>
      )}

      {/* Tick Timeline Scrubber */}
      {ticksWithFiber.length > 0 && (
        <div className="fiber-timeline">
          <div className="fiber-timeline-label">Timeline</div>
          <button
            className={`fiber-timeline-latest ${selectedTick === "latest" ? "active" : ""}`}
            onClick={() => setSelectedTick("latest")}
            title="Latest state (live)"
          >
            Latest
          </button>
          <div className="fiber-timeline-scrubber">
            <div className="fiber-timeline-rail" />
            <div
              className="fiber-timeline-rail-fill"
              style={{
                width: (() => {
                  if (selectedTick === "latest") return "100%";
                  const idx = ticksWithFiber.findIndex((t) => t.number === selectedTick);
                  if (idx === -1 || ticksWithFiber.length <= 1) return "0%";
                  return `${(idx / (ticksWithFiber.length - 1)) * 100}%`;
                })(),
              }}
            />
            <div className="fiber-timeline-ticks">
              {ticksWithFiber.map((t) => (
                <button
                  key={t.number}
                  className={`fiber-timeline-tick ${selectedTick === t.number ? "active" : ""}`}
                  onClick={() => setSelectedTick(t.number)}
                  title={`Tick ${t.number}${t.fiberSummary ? ` - ${t.fiberSummary.componentCount} components` : ""}`}
                  style={{
                    opacity:
                      selectedTick === "latest" ||
                      (typeof selectedTick === "number" && t.number <= selectedTick)
                        ? 1
                        : 0.5,
                  }}
                >
                  <span className="fiber-timeline-tick-label">Tick {t.number}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="fiber-timeline-info">
            {selectedTick === "latest" ? <span>Latest</span> : <span>Tick {selectedTick}</span>}
          </div>
        </div>
      )}

      {/* Tree */}
      <div className="fiber-tree">
        <div className="fiber-toolbar">
          <button className="btn btn-sm" onClick={expandAll}>
            Expand All
          </button>
          <button className="btn btn-sm" onClick={collapseAll}>
            Collapse All
          </button>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: 12,
              marginLeft: "auto",
            }}
          >
            <input
              type="checkbox"
              checked={showHooks}
              onChange={(e) => setShowHooks(e.target.checked)}
            />
            Show Hooks
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
            <input
              type="checkbox"
              checked={showProps}
              onChange={(e) => setShowProps(e.target.checked)}
            />
            Show Props
          </label>
        </div>
        <FiberNodeView
          node={fiberTree}
          expandedNodes={expandedNodes}
          selectedNode={selectedNode}
          onToggle={toggleNode}
          onSelect={setSelectedNode}
          showHooks={showHooks}
          showProps={showProps}
        />
      </div>
    </div>
  );
}

function FiberNodeView({
  node,
  expandedNodes,
  selectedNode,
  onToggle,
  onSelect,
  showHooks,
  showProps,
}: {
  node: FiberNode;
  expandedNodes: Set<string>;
  selectedNode: string | null;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  showHooks: boolean;
  showProps: boolean;
}) {
  // Skip rendering tentickle.fragment nodes - just render their children directly
  // This flattens the tree like how React fragments work
  if (node.type === "tentickle.fragment") {
    return (
      <>
        {node.children.map((child) => (
          <FiberNodeView
            key={child.id}
            node={child}
            expandedNodes={expandedNodes}
            selectedNode={selectedNode}
            onToggle={onToggle}
            onSelect={onSelect}
            showHooks={showHooks}
            showProps={showProps}
          />
        ))}
      </>
    );
  }

  const hasChildren = node.children.length > 0;
  const hasHooks = node.hooks.length > 0;
  const hasProps = Object.keys(node.props).length > 0;
  const isExpanded = expandedNodes.has(node.id);
  const isSelected = selectedNode === node.id;
  const isHostElement = node.type.startsWith("tentickle.") || node.type === "text";

  // Extract text preview for text/content nodes
  const getTextPreview = (): string | null => {
    // For <text> nodes, show the value
    if (node.type === "text" && node.props.value) {
      const text = String(node.props.value);
      return text.length > 50 ? text.slice(0, 50) + "..." : text;
    }
    // For semantic blocks with text content
    if (node.props.text) {
      const text = String(node.props.text);
      return text.length > 50 ? text.slice(0, 50) + "..." : text;
    }
    // For children that are strings
    if (node.props.children && typeof node.props.children === "string") {
      const text = node.props.children;
      return text.length > 50 ? text.slice(0, 50) + "..." : text;
    }
    return null;
  };

  const textPreview = getTextPreview();

  return (
    <div className="fiber-node">
      <div
        className={`fiber-node-row ${isSelected ? "selected" : ""}`}
        onClick={() => onSelect(node.id)}
      >
        <span
          className={`fiber-expand-btn ${isExpanded ? "expanded" : ""} ${!hasChildren ? "empty" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggle(node.id);
          }}
        >
          ▶
        </span>
        <span className={`fiber-type ${isHostElement ? "host" : ""}`}>&lt;{node.type}&gt;</span>
        {node.key && <span className="fiber-key">key="{node.key}"</span>}
        {/* Show component summary if available (e.g., message role, tool name) */}
        {node._summary && <span className="fiber-summary">{node._summary}</span>}
        {/* Fallback to text preview if no summary */}
        {!node._summary && textPreview && (
          <span className="fiber-text-preview">"{textPreview}"</span>
        )}
        {hasHooks && (
          <span className="fiber-hooks-badge">
            {node.hooks.length} hook{node.hooks.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Hooks Panel */}
      {showHooks && hasHooks && isExpanded && (
        <div className="fiber-hooks-panel">
          {node.hooks.map((hook) => (
            <HookView key={hook.index} hook={hook} />
          ))}
        </div>
      )}

      {/* Props Panel */}
      {showProps && hasProps && isExpanded && (
        <div className="props-panel">
          {Object.entries(node.props)
            .slice(0, 10)
            .map(([key, value]) => (
              <div key={key} className="prop-item">
                <span className="prop-key">{key}:</span>
                <span className="prop-value">{formatValue(value)}</span>
              </div>
            ))}
          {Object.keys(node.props).length > 10 && (
            <div style={{ color: "var(--text-muted)", fontSize: 10 }}>
              ... and {Object.keys(node.props).length - 10} more props
            </div>
          )}
        </div>
      )}

      {/* Children */}
      {hasChildren && isExpanded && (
        <div className="fiber-children">
          {node.children.map((child) => (
            <FiberNodeView
              key={child.id}
              node={child}
              expandedNodes={expandedNodes}
              selectedNode={selectedNode}
              onToggle={onToggle}
              onSelect={onSelect}
              showHooks={showHooks}
              showProps={showProps}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HookView({ hook }: { hook: HookState }) {
  return (
    <div className="fiber-hook">
      <span className="fiber-hook-type">
        {hook.type}[{hook.index}]
      </span>
      <span className="fiber-hook-value">{formatValue(hook.value)}</span>
      {hook.deps && <span className="fiber-hook-deps">deps: [{hook.deps.length}]</span>}
      {hook.status && (
        <span style={{ color: "var(--accent-green)", fontSize: 10 }}>{hook.status}</span>
      )}
    </div>
  );
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    if (value.length > 60) return `"${value.slice(0, 60)}..."`;
    return `"${value}"`;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "function") return "[Function]";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${value.length} items]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;

    // Special handling for Signal/Computed values from serialization
    if (obj._type === "Signal") {
      const inner = formatValue(obj.value);
      return `Signal(${inner})`;
    }
    if (obj._type === "Computed") {
      const inner = formatValue(obj.value);
      return `Computed(${inner})`;
    }
    if (obj._type === "Error") {
      return `Error: ${obj.message}`;
    }

    const keys = Object.keys(obj).filter((k) => !k.startsWith("_"));
    if (keys.length === 0) return "{}";
    if (keys.length <= 3) return `{${keys.join(", ")}}`;
    return `{${keys.slice(0, 3).join(", ")}, ...}`;
  }
  return String(value);
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
