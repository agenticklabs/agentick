import type { Execution } from "../hooks/useDevToolsEvents.js";

interface ExecutionListProps {
  executions: Execution[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ExecutionList({ executions, selectedId, onSelect }: ExecutionListProps) {
  if (executions.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📭</div>
        <div className="empty-state-title">No executions yet</div>
        <div className="empty-state-text">
          Executions will appear here when your agent starts running
        </div>
      </div>
    );
  }

  return (
    <div className="execution-list">
      {executions.map((exec) => (
        <ExecutionItem
          key={exec.id}
          execution={exec}
          isSelected={exec.id === selectedId}
          onSelect={() => onSelect(exec.id)}
        />
      ))}
    </div>
  );
}

interface ExecutionItemProps {
  execution: Execution;
  isSelected: boolean;
  onSelect: () => void;
}

function ExecutionItem({ execution, isSelected, onSelect }: ExecutionItemProps) {
  const statusIcon =
    execution.status === "running" ? "⏳" : execution.status === "error" ? "❌" : "✓";

  const formatDuration = () => {
    if (!execution.endTime) return "running...";
    const ms = execution.endTime - execution.startTime;
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const formatRelativeTime = (timestamp: number) => {
    const diff = Date.now() - timestamp;
    if (diff < 1000) return "just now";
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return new Date(timestamp).toLocaleDateString();
  };

  const tokens =
    execution.totalUsage?.totalTokens ??
    execution.ticks.reduce((sum, t) => sum + (t.usage?.totalTokens ?? 0), 0);

  const inputTokens =
    execution.totalUsage?.inputTokens ??
    execution.ticks.reduce((sum, t) => sum + (t.usage?.inputTokens ?? 0), 0);

  const outputTokens =
    execution.totalUsage?.outputTokens ??
    execution.ticks.reduce((sum, t) => sum + (t.usage?.outputTokens ?? 0), 0);

  return (
    <div className={`execution-item ${isSelected ? "selected" : ""}`} onClick={onSelect}>
      <div className={`execution-status ${execution.status}`}>{statusIcon}</div>
      <div className="execution-info">
        <div className="execution-name">{execution.rootComponent}</div>
        <div className="execution-meta">
          <span className="execution-meta-item" title="Ticks">
            🔄 {execution.ticks.length}
          </span>
          <span
            className="execution-meta-item"
            title={`Input: ${inputTokens} / Output: ${outputTokens}`}
          >
            📊 {tokens.toLocaleString()} tk
          </span>
          <span className="execution-meta-item" title="Duration">
            ⏱️ {formatDuration()}
          </span>
        </div>
      </div>
      <div className="execution-time">{formatRelativeTime(execution.startTime)}</div>
    </div>
  );
}
