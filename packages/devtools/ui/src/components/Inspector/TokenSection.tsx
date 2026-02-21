import { useState } from "react";
import type { TokenSummary } from "../../hooks/useDevToolsEvents.js";

interface TokenSectionProps {
  tokenSummary: TokenSummary;
}

/**
 * Format token count for display.
 */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(1)}k`;
}

/**
 * Calculate percentage.
 */
function percentage(part: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

export function TokenSection({ tokenSummary }: TokenSectionProps) {
  const [expanded, setExpanded] = useState(true);

  const { system, messages, tools, ephemeral, total } = tokenSummary;

  return (
    <div className="inspector-section">
      <div className="inspector-section-header" onClick={() => setExpanded(!expanded)}>
        <span className={`inspector-section-toggle ${expanded ? "expanded" : ""}`}>&#9654;</span>
        <span className="inspector-section-title">Tokens</span>
        <span className="inspector-section-count">~{formatTokens(total)}</span>
      </div>

      {expanded && (
        <div className="inspector-section-content">
          <div className="token-breakdown">
            {/* Visual bar */}
            <div className="token-bar">
              {system > 0 && (
                <div
                  className="token-bar-segment token-system"
                  style={{ width: percentage(system, total) }}
                  title={`System: ${formatTokens(system)}`}
                />
              )}
              {messages > 0 && (
                <div
                  className="token-bar-segment token-messages"
                  style={{ width: percentage(messages, total) }}
                  title={`Messages: ${formatTokens(messages)}`}
                />
              )}
              {tools > 0 && (
                <div
                  className="token-bar-segment token-tools"
                  style={{ width: percentage(tools, total) }}
                  title={`Tools: ${formatTokens(tools)}`}
                />
              )}
              {ephemeral > 0 && (
                <div
                  className="token-bar-segment token-ephemeral"
                  style={{ width: percentage(ephemeral, total) }}
                  title={`Ephemeral: ${formatTokens(ephemeral)}`}
                />
              )}
            </div>

            {/* Legend */}
            <div className="token-legend">
              <div className="token-legend-item">
                <span className="token-legend-color token-system" />
                <span className="token-legend-label">System</span>
                <span className="token-legend-value">{formatTokens(system)}</span>
              </div>
              <div className="token-legend-item">
                <span className="token-legend-color token-messages" />
                <span className="token-legend-label">Messages</span>
                <span className="token-legend-value">{formatTokens(messages)}</span>
              </div>
              <div className="token-legend-item">
                <span className="token-legend-color token-tools" />
                <span className="token-legend-label">Tools</span>
                <span className="token-legend-value">{formatTokens(tools)}</span>
              </div>
              {ephemeral > 0 && (
                <div className="token-legend-item">
                  <span className="token-legend-color token-ephemeral" />
                  <span className="token-legend-label">Ephemeral</span>
                  <span className="token-legend-value">{formatTokens(ephemeral)}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
