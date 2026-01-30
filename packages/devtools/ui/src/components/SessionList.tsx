import { useState } from "react";
import type { Session, Execution } from "../hooks/useDevToolsEvents";

interface SessionListProps {
  sessions: Session[];
  executions: Execution[];
  selectedSessionId: string | null;
  selectedExecutionId: string | null;
  onSelectSession: (id: string) => void;
  onSelectExecution: (id: string) => void;
}

export function SessionList({
  sessions,
  executions,
  selectedSessionId,
  selectedExecutionId,
  onSelectSession,
  onSelectExecution,
}: SessionListProps) {
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());

  // Group executions without sessions as "Direct Calls"
  const directCalls = executions.filter((e) => !e.sessionId);

  if (sessions.length === 0 && directCalls.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📭</div>
        <div className="empty-state-text">No sessions yet</div>
      </div>
    );
  }

  const toggleSession = (sessionId: string) => {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  };

  return (
    <div className="execution-list">
      {sessions.map((session) => {
        const isExpanded = expandedSessions.has(session.id);
        const sessionExecutions = session.executions
          .map((id) => executions.find((e) => e.id === id))
          .filter((e): e is Execution => !!e)
          .sort((a, b) => b.startTime - a.startTime);

        return (
          <div key={session.id} className="session-group">
            <div
              className={`session-header ${selectedSessionId === session.id ? "selected" : ""}`}
              onClick={() => {
                toggleSession(session.id);
                onSelectSession(session.id);
              }}
            >
              <span className="session-icon">{isExpanded ? "▼" : "▶"}</span>
              <span className="session-name">{session.rootComponent}</span>
              <span className="session-count">{sessionExecutions.length}</span>
            </div>
            {isExpanded && (
              <div className="session-executions">
                {sessionExecutions.map((exec) => (
                  <SessionExecutionItem
                    key={exec.id}
                    execution={exec}
                    isSelected={exec.id === selectedExecutionId}
                    onSelect={() => onSelectExecution(exec.id)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {directCalls.length > 0 && (
        <div className="session-group">
          <div className="session-header">
            <span className="session-icon">📤</span>
            <span className="session-name">Direct Calls</span>
            <span className="session-count">{directCalls.length}</span>
          </div>
          <div className="session-executions">
            {directCalls.map((exec) => (
              <SessionExecutionItem
                key={exec.id}
                execution={exec}
                isSelected={exec.id === selectedExecutionId}
                onSelect={() => onSelectExecution(exec.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface SessionExecutionItemProps {
  execution: Execution;
  isSelected: boolean;
  onSelect: () => void;
}

function SessionExecutionItem({ execution, isSelected, onSelect }: SessionExecutionItemProps) {
  const statusIcon =
    execution.status === "running" ? "🟢" : execution.status === "error" ? "❌" : "✓";

  return (
    <div
      className={`execution-item ${isSelected ? "selected" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
    >
      <span className={`execution-status ${execution.status}`}>{statusIcon}</span>
      <span className="execution-name">Execution {execution.ticks.length}t</span>
    </div>
  );
}
