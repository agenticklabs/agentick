import { useState } from "react";
import type { Execution, Session, FiberNode, TokenSummary } from "../hooks/useDevToolsEvents";
import { Tree } from "./Tree";
import { getModelInfo, getContextUtilization, formatContextWindow } from "@agentick/shared";

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

      {/* Context Utilization - prefer real-time contextInfo over catalog lookup */}
      {(execution.ticks[execution.ticks.length - 1]?.contextInfo || execution.ticks[0]?.model) && (
        <ContextUtilizationCard
          modelId={
            execution.ticks[execution.ticks.length - 1]?.contextInfo?.modelId ||
            execution.ticks[0]?.model ||
            ""
          }
          usedTokens={execInputTokens}
          contextInfo={execution.ticks[execution.ticks.length - 1]?.contextInfo}
        />
      )}

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
// Context Utilization Card - Shows how much of the model's context is used
// ============================================================================

function ContextUtilizationCard({
  modelId,
  usedTokens,
  contextInfo,
}: {
  modelId: string;
  usedTokens: number;
  contextInfo?: {
    modelId: string;
    contextWindow?: number;
    utilization?: number;
    provider?: string;
    supportsVision?: boolean;
    supportsToolUse?: boolean;
    isReasoningModel?: boolean;
    maxOutputTokens?: number;
  };
}) {
  // Prefer contextInfo from real-time events over catalog lookup
  const effectiveModelId = contextInfo?.modelId || modelId;
  const modelInfo = contextInfo?.contextWindow
    ? { contextWindow: contextInfo.contextWindow, maxOutputTokens: contextInfo.maxOutputTokens }
    : getModelInfo(effectiveModelId);
  const utilization =
    contextInfo?.utilization ?? getContextUtilization(effectiveModelId, usedTokens);

  if (!modelInfo || utilization === undefined) {
    return null;
  }

  const contextWindow = modelInfo.contextWindow;
  const formattedWindow = formatContextWindow(contextWindow);
  const utilizationPercent = utilization.toFixed(1);

  // Color based on utilization level
  const getUtilizationColor = (pct: number) => {
    if (pct >= 90) return "var(--accent-red)";
    if (pct >= 75) return "var(--accent-orange)";
    if (pct >= 50) return "var(--accent-yellow)";
    return "var(--accent-green)";
  };

  const barColor = getUtilizationColor(utilization);

  return (
    <div className="context-utilization-card">
      <div className="context-utilization-header">
        <span className="context-utilization-label">Context Utilization</span>
        <span className="context-utilization-value">
          {usedTokens.toLocaleString()} / {formattedWindow} tokens ({utilizationPercent}%)
        </span>
      </div>
      <div className="context-utilization-bar-container">
        <div
          className="context-utilization-bar"
          style={{
            width: `${Math.min(100, utilization)}%`,
            backgroundColor: barColor,
          }}
        />
      </div>
      {modelInfo.maxOutputTokens && (
        <div className="context-utilization-detail">
          Max output: {formatContextWindow(modelInfo.maxOutputTokens)} tokens
        </div>
      )}
      {/* Model Capabilities */}
      {contextInfo && (
        <div className="context-header-details" style={{ marginTop: 8 }}>
          {contextInfo.provider && (
            <span className="context-badge provider">{contextInfo.provider}</span>
          )}
          {contextInfo.supportsVision && <span className="context-badge capability">Vision</span>}
          {contextInfo.supportsToolUse && <span className="context-badge capability">Tools</span>}
          {contextInfo.isReasoningModel && (
            <span className="context-badge capability">Reasoning</span>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Pipeline Stage Component - Collapsible section for a transformation stage
// ============================================================================

type ViewMode = "pretty" | "json";
type PipelineDataType =
  | "compiled"
  | "rendered"
  | "modelInput"
  | "providerInput"
  | "providerOutput"
  | "modelOutput"
  | "engineState";

interface PipelineStageProps {
  number: number;
  title: string;
  subtitle: string;
  data: unknown;
  dataType?: PipelineDataType;
  defaultExpanded?: boolean;
}

function PipelineStage({
  number,
  title,
  subtitle,
  data,
  dataType,
  defaultExpanded = false,
}: PipelineStageProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [viewMode, setViewMode] = useState<ViewMode>("pretty");

  const hasData = data !== undefined && data !== null;

  const toggleViewMode = (e: React.MouseEvent) => {
    e.stopPropagation();
    setViewMode((m) => (m === "pretty" ? "json" : "pretty"));
  };

  return (
    <div className={`pipeline-stage ${hasData ? "" : "no-data"}`}>
      <div className="pipeline-stage-header" onClick={() => hasData && setExpanded(!expanded)}>
        <div className={`pipeline-stage-number ${hasData ? "" : "dim"}`}>{number}</div>
        <div className="pipeline-stage-info">
          <div className={`pipeline-stage-title ${hasData ? "" : "dim"}`}>{title}</div>
          <div className="pipeline-stage-subtitle">{subtitle}</div>
        </div>
        {hasData && expanded && (
          <button
            className={`pipeline-view-toggle ${viewMode === "json" ? "active" : ""}`}
            onClick={toggleViewMode}
            title={viewMode === "pretty" ? "Show JSON" : "Show Pretty"}
          >
            {"{ }"}
          </button>
        )}
        {hasData && (
          <span className={`pipeline-stage-expand ${expanded ? "expanded" : ""}`}>▶</span>
        )}
        {!hasData && <span className="pipeline-stage-empty-badge">No data</span>}
      </div>
      {hasData && expanded && (
        <div className="pipeline-stage-body">
          {viewMode === "json" ? (
            <pre className="json-view">{JSON.stringify(data, null, 2)}</pre>
          ) : (
            <PrettyView data={data} dataType={dataType} />
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Pretty View Renderers - User-friendly representations of pipeline data
// ============================================================================

function PrettyView({ data, dataType }: { data: unknown; dataType?: PipelineDataType }) {
  if (!data) return null;

  switch (dataType) {
    case "compiled":
      return <CompiledStructureView data={data} />;
    case "rendered":
      return <RenderedInputView data={data} />;
    case "modelInput":
      return <ModelInputView data={data} />;
    case "providerInput":
      return <ProviderInputView data={data} />;
    case "providerOutput":
      return <ProviderOutputView data={data} />;
    case "modelOutput":
      return <ModelOutputView data={data} />;
    case "engineState":
      return <EngineStateView data={data} />;
    default:
      // Fallback to JSON for unknown types
      return <pre className="json-view">{JSON.stringify(data, null, 2)}</pre>;
  }
}

// ---- Compiled Structure View ----
function CompiledStructureView({ data }: { data: unknown }) {
  const compiled = data as {
    sections?: Record<string, { id: string; content: unknown[]; audience?: string }>;
    timelineEntries?: unknown[];
    system?: unknown[];
    tools?: unknown[];
    ephemeral?: unknown[];
  };

  return (
    <div className="pretty-view">
      {/* Sections */}
      {compiled.sections && Object.keys(compiled.sections).length > 0 && (
        <div className="pretty-section">
          <div className="pretty-section-header">
            <span className="pretty-section-icon">📑</span>
            Sections ({Object.keys(compiled.sections).length})
          </div>
          <div className="pretty-section-content">
            {Object.entries(compiled.sections).map(([key, section]) => (
              <div key={key} className="pretty-card">
                <div className="pretty-card-header">
                  <span className="pretty-card-title">{section.id || key}</span>
                  {section.audience && <span className="pretty-badge">{section.audience}</span>}
                </div>
                <div className="pretty-card-content">{renderContentBlocks(section.content)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Timeline Entries */}
      {compiled.timelineEntries && compiled.timelineEntries.length > 0 && (
        <div className="pretty-section">
          <div className="pretty-section-header">
            <span className="pretty-section-icon">💬</span>
            Timeline ({compiled.timelineEntries.length} entries)
          </div>
          <div className="pretty-section-content">
            <MessageList messages={compiled.timelineEntries as any[]} />
          </div>
        </div>
      )}

      {/* Tools */}
      {compiled.tools && compiled.tools.length > 0 && (
        <div className="pretty-section">
          <div className="pretty-section-header">
            <span className="pretty-section-icon">🔧</span>
            Tools ({compiled.tools.length})
          </div>
          <div className="pretty-section-content">
            <ToolsList tools={compiled.tools as any[]} />
          </div>
        </div>
      )}

      {/* System */}
      {compiled.systemEntries && (compiled.systemEntries as any[]).length > 0 && (
        <div className="pretty-section">
          <div className="pretty-section-header">
            <span className="pretty-section-icon">⚙️</span>
            System
          </div>
          <div className="pretty-section-content">
            {renderContentBlocks(compiled.systemEntries)}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Rendered Input View ----
function RenderedInputView({ data }: { data: unknown }) {
  const rendered = data as {
    timeline?: unknown[];
    system?: unknown[];
    sections?: Record<string, unknown>;
    tools?: unknown[];
    ephemeral?: unknown[];
  };

  return (
    <div className="pretty-view">
      {/* System */}
      {rendered.system && (rendered.system as any[]).length > 0 && (
        <div className="pretty-section">
          <div className="pretty-section-header">
            <span className="pretty-section-icon">⚙️</span>
            System Prompt
          </div>
          <div className="pretty-section-content">{renderContentBlocks(rendered.system)}</div>
        </div>
      )}

      {/* Timeline */}
      {rendered.timeline && (rendered.timeline as any[]).length > 0 && (
        <div className="pretty-section">
          <div className="pretty-section-header">
            <span className="pretty-section-icon">💬</span>
            Messages ({(rendered.timeline as any[]).length})
          </div>
          <div className="pretty-section-content">
            <MessageList messages={rendered.timeline as any[]} />
          </div>
        </div>
      )}

      {/* Tools */}
      {rendered.tools && (rendered.tools as any[]).length > 0 && (
        <div className="pretty-section">
          <div className="pretty-section-header">
            <span className="pretty-section-icon">🔧</span>
            Tools ({(rendered.tools as any[]).length})
          </div>
          <div className="pretty-section-content">
            <ToolsList tools={rendered.tools as any[]} />
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Model Input View ----
function ModelInputView({ data }: { data: unknown }) {
  const input = data as {
    messages?: unknown[];
    tools?: unknown[];
    system?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };

  return (
    <div className="pretty-view">
      {/* Model Config */}
      {(input.model || input.temperature !== undefined || input.maxTokens !== undefined) && (
        <div className="pretty-config">
          {input.model && (
            <span className="pretty-config-item">
              <span className="pretty-config-label">Model:</span> {input.model}
            </span>
          )}
          {input.temperature !== undefined && (
            <span className="pretty-config-item">
              <span className="pretty-config-label">Temp:</span> {input.temperature}
            </span>
          )}
          {input.maxTokens !== undefined && (
            <span className="pretty-config-item">
              <span className="pretty-config-label">Max:</span> {input.maxTokens}
            </span>
          )}
        </div>
      )}

      {/* System */}
      {input.system && (
        <div className="pretty-section">
          <div className="pretty-section-header">
            <span className="pretty-section-icon">⚙️</span>
            System Prompt
          </div>
          <div className="pretty-section-content">
            <div className="pretty-system-prompt">{input.system}</div>
          </div>
        </div>
      )}

      {/* Messages */}
      {input.messages && input.messages.length > 0 && (
        <div className="pretty-section">
          <div className="pretty-section-header">
            <span className="pretty-section-icon">💬</span>
            Messages ({input.messages.length})
          </div>
          <div className="pretty-section-content">
            <MessageList messages={input.messages as any[]} />
          </div>
        </div>
      )}

      {/* Tools */}
      {input.tools && input.tools.length > 0 && (
        <div className="pretty-section">
          <div className="pretty-section-header">
            <span className="pretty-section-icon">🔧</span>
            Tools ({input.tools.length})
          </div>
          <div className="pretty-section-content">
            <ToolsList tools={input.tools as any[]} />
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Provider Input View ----
function ProviderInputView({ data }: { data: unknown }) {
  const input = data as Record<string, unknown>;

  // Extract common fields
  const model = input.model as string | undefined;
  const messages = input.messages as unknown[] | undefined;
  const tools = input.tools as unknown[] | undefined;

  return (
    <div className="pretty-view">
      {/* Provider-specific config summary */}
      <div className="pretty-config">
        {model && (
          <span className="pretty-config-item">
            <span className="pretty-config-label">Model:</span> {model}
          </span>
        )}
        {messages && (
          <span className="pretty-config-item">
            <span className="pretty-config-label">Messages:</span> {messages.length}
          </span>
        )}
        {tools && (
          <span className="pretty-config-item">
            <span className="pretty-config-label">Tools:</span> {tools.length}
          </span>
        )}
      </div>

      {/* Messages (provider format) */}
      {messages && messages.length > 0 && (
        <div className="pretty-section">
          <div className="pretty-section-header">
            <span className="pretty-section-icon">💬</span>
            Messages (Provider Format)
          </div>
          <div className="pretty-section-content">
            <MessageList messages={messages as any[]} isProviderFormat />
          </div>
        </div>
      )}

      {/* Tools (provider format) - show as JSON since format varies */}
      {tools && tools.length > 0 && (
        <div className="pretty-section">
          <div className="pretty-section-header">
            <span className="pretty-section-icon">🔧</span>
            Tools (Provider Format)
          </div>
          <div className="pretty-section-content">
            <ToolsList tools={tools as any[]} isProviderFormat />
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Provider Output View ----
function ProviderOutputView({ data }: { data: unknown }) {
  const output = data as Record<string, unknown>;

  // Try to extract common fields from different provider formats
  const choices = output.choices as any[] | undefined;
  const candidates = output.candidates as any[] | undefined;
  const usage = output.usage as Record<string, number> | undefined;
  const usageMetadata = output.usageMetadata as Record<string, number> | undefined;
  const model = output.model as string | undefined;

  const message = choices?.[0]?.message || candidates?.[0]?.content;
  const finishReason = choices?.[0]?.finish_reason || candidates?.[0]?.finishReason;

  return (
    <div className="pretty-view">
      {/* Summary */}
      <div className="pretty-config">
        {model && (
          <span className="pretty-config-item">
            <span className="pretty-config-label">Model:</span> {model}
          </span>
        )}
        {finishReason && (
          <span className="pretty-config-item">
            <span className="pretty-config-label">Finish:</span> {finishReason}
          </span>
        )}
        {(usage || usageMetadata) && (
          <span className="pretty-config-item">
            <span className="pretty-config-label">Tokens:</span>{" "}
            {usage?.total_tokens ||
              usageMetadata?.totalTokenCount ||
              (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0)}
          </span>
        )}
      </div>

      {/* Message Content */}
      {message && (
        <div className="pretty-section">
          <div className="pretty-section-header">
            <span className="pretty-section-icon">🤖</span>
            Response
          </div>
          <div className="pretty-section-content">
            {typeof message === "string" ? (
              <div className="pretty-message assistant">{message}</div>
            ) : message.content ? (
              <div className="pretty-message assistant">
                {typeof message.content === "string"
                  ? message.content
                  : renderContentBlocks(
                      Array.isArray(message.content) ? message.content : [message.content],
                    )}
              </div>
            ) : (
              <pre className="json-view">{JSON.stringify(message, null, 2)}</pre>
            )}
          </div>
        </div>
      )}

      {/* Tool Calls */}
      {message?.tool_calls && message.tool_calls.length > 0 && (
        <div className="pretty-section">
          <div className="pretty-section-header">
            <span className="pretty-section-icon">🔧</span>
            Tool Calls ({message.tool_calls.length})
          </div>
          <div className="pretty-section-content">
            {message.tool_calls.map((tc: any, i: number) => (
              <div key={i} className="pretty-tool-call">
                <div className="pretty-tool-call-header">
                  <span className="pretty-tool-call-name">
                    {tc.function?.name || tc.name || "tool"}
                  </span>
                  <span className="pretty-tool-call-id">{tc.id?.slice(0, 12)}...</span>
                </div>
                <pre className="json-view" style={{ margin: 0 }}>
                  {tc.function?.arguments || JSON.stringify(tc.input || tc.args || {}, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Usage */}
      {(usage || usageMetadata) && (
        <div className="pretty-section">
          <div className="pretty-section-header">
            <span className="pretty-section-icon">📊</span>
            Usage
          </div>
          <div className="pretty-section-content">
            <div className="pretty-usage">
              <div className="pretty-usage-item">
                <span className="pretty-usage-value">
                  {usage?.prompt_tokens ?? usageMetadata?.promptTokenCount ?? 0}
                </span>
                <span className="pretty-usage-label">Input</span>
              </div>
              <div className="pretty-usage-item">
                <span className="pretty-usage-value">
                  {usage?.completion_tokens ?? usageMetadata?.candidatesTokenCount ?? 0}
                </span>
                <span className="pretty-usage-label">Output</span>
              </div>
              <div className="pretty-usage-item">
                <span className="pretty-usage-value">
                  {usage?.total_tokens ?? usageMetadata?.totalTokenCount ?? 0}
                </span>
                <span className="pretty-usage-label">Total</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Model Output View ----
function ModelOutputView({ data }: { data: unknown }) {
  const output = data as {
    message?: { role: string; content: unknown[] };
    messages?: { role: string; content: unknown[] }[];
    usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
    stopReason?: string;
    toolCalls?: { id: string; name: string; input: unknown }[];
    model?: string;
  };

  const message = output.message || output.messages?.[0];

  return (
    <div className="pretty-view">
      {/* Summary */}
      <div className="pretty-config">
        {output.model && (
          <span className="pretty-config-item">
            <span className="pretty-config-label">Model:</span> {output.model}
          </span>
        )}
        {output.stopReason && (
          <span className="pretty-config-item">
            <span className="pretty-config-label">Stop:</span> {output.stopReason}
          </span>
        )}
      </div>

      {/* Message */}
      {message && (
        <div className="pretty-section">
          <div className="pretty-section-header">
            <span className="pretty-section-icon">🤖</span>
            Response
          </div>
          <div className="pretty-section-content">
            <div className="pretty-message assistant">
              {renderContentBlocks(message.content as any[])}
            </div>
          </div>
        </div>
      )}

      {/* Tool Calls */}
      {output.toolCalls && output.toolCalls.length > 0 && (
        <div className="pretty-section">
          <div className="pretty-section-header">
            <span className="pretty-section-icon">🔧</span>
            Tool Calls ({output.toolCalls.length})
          </div>
          <div className="pretty-section-content">
            {output.toolCalls.map((tc, i) => (
              <div key={i} className="pretty-tool-call">
                <div className="pretty-tool-call-header">
                  <span className="pretty-tool-call-name">{tc.name}</span>
                  <span className="pretty-tool-call-id">{tc.id?.slice(0, 12)}...</span>
                </div>
                <pre className="json-view" style={{ margin: 0 }}>
                  {JSON.stringify(tc.input, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Usage */}
      {output.usage && (
        <div className="pretty-section">
          <div className="pretty-section-header">
            <span className="pretty-section-icon">📊</span>
            Usage
          </div>
          <div className="pretty-section-content">
            <div className="pretty-usage">
              <div className="pretty-usage-item">
                <span className="pretty-usage-value">{output.usage.inputTokens}</span>
                <span className="pretty-usage-label">Input</span>
              </div>
              <div className="pretty-usage-item">
                <span className="pretty-usage-value">{output.usage.outputTokens}</span>
                <span className="pretty-usage-label">Output</span>
              </div>
              <div className="pretty-usage-item">
                <span className="pretty-usage-value">{output.usage.totalTokens}</span>
                <span className="pretty-usage-label">Total</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Engine State View ----
function EngineStateView({ data }: { data: unknown }) {
  const state = data as {
    newTimelineEntries?: unknown[];
    toolCalls?: unknown[];
    shouldStop?: boolean;
    stopReason?: unknown;
  };

  return (
    <div className="pretty-view">
      {/* Summary */}
      <div className="pretty-config">
        <span className="pretty-config-item">
          <span className="pretty-config-label">Stop:</span> {state.shouldStop ? "Yes" : "No"}
        </span>
        {state.stopReason && (
          <span className="pretty-config-item">
            <span className="pretty-config-label">Reason:</span> {String(state.stopReason)}
          </span>
        )}
        {state.newTimelineEntries && (
          <span className="pretty-config-item">
            <span className="pretty-config-label">New Entries:</span>{" "}
            {state.newTimelineEntries.length}
          </span>
        )}
        {state.toolCalls && (
          <span className="pretty-config-item">
            <span className="pretty-config-label">Tool Calls:</span> {state.toolCalls.length}
          </span>
        )}
      </div>

      {/* Timeline Entries */}
      {state.newTimelineEntries && state.newTimelineEntries.length > 0 && (
        <div className="pretty-section">
          <div className="pretty-section-header">
            <span className="pretty-section-icon">📝</span>
            New Timeline Entries
          </div>
          <div className="pretty-section-content">
            <MessageList messages={state.newTimelineEntries as any[]} />
          </div>
        </div>
      )}

      {/* Tool Calls */}
      {state.toolCalls && state.toolCalls.length > 0 && (
        <div className="pretty-section">
          <div className="pretty-section-header">
            <span className="pretty-section-icon">🔧</span>
            Tool Calls to Execute
          </div>
          <div className="pretty-section-content">
            {(state.toolCalls as any[]).map((tc, i) => (
              <div key={i} className="pretty-tool-call">
                <div className="pretty-tool-call-header">
                  <span className="pretty-tool-call-name">{tc.name}</span>
                  <span className="pretty-tool-call-id">{tc.id?.slice(0, 12)}...</span>
                </div>
                <pre className="json-view" style={{ margin: 0 }}>
                  {JSON.stringify(tc.input, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Shared Components for Pretty Views
// ============================================================================

function MessageList({
  messages,
  isProviderFormat,
}: {
  messages: any[];
  isProviderFormat?: boolean;
}) {
  return (
    <div className="pretty-messages">
      {messages.map((msg, i) => {
        const role = msg.role || msg.kind || "unknown";
        const content = msg.content || msg.message?.content || msg.parts || [];

        return (
          <div key={i} className={`pretty-message ${role}`}>
            <div className="pretty-message-role">{role}</div>
            <div className="pretty-message-content">
              {typeof content === "string" ? (
                content
              ) : Array.isArray(content) ? (
                renderContentBlocks(content)
              ) : (
                <pre className="json-view" style={{ margin: 0 }}>
                  {JSON.stringify(content, null, 2)}
                </pre>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ToolsList({ tools, isProviderFormat }: { tools: any[]; isProviderFormat?: boolean }) {
  return (
    <div className="pretty-tools">
      {tools.map((tool, i) => {
        // Handle different tool formats
        const name =
          tool.name ||
          tool.function?.name ||
          tool.metadata?.name ||
          tool.functionDeclarations?.[0]?.name ||
          `Tool ${i + 1}`;
        const description =
          tool.description ||
          tool.function?.description ||
          tool.metadata?.description ||
          tool.functionDeclarations?.[0]?.description ||
          "";

        return (
          <div key={i} className="pretty-tool">
            <span className="pretty-tool-name">{name}</span>
            {description && <span className="pretty-tool-desc">{description}</span>}
          </div>
        );
      })}
    </div>
  );
}

function renderContentBlocks(blocks: unknown[]): React.ReactNode {
  if (!blocks || !Array.isArray(blocks)) return null;

  return blocks.map((block: any, i) => {
    if (!block) return null;

    // Text block
    if (block.type === "text" || typeof block === "string") {
      const text = typeof block === "string" ? block : block.text;
      return (
        <div key={i} className="pretty-content-text">
          {text}
        </div>
      );
    }

    // Tool use block
    if (block.type === "tool_use") {
      return (
        <div key={i} className="pretty-tool-call inline">
          <span className="pretty-tool-call-name">{block.name}</span>
          <pre className="json-view" style={{ margin: 0 }}>
            {JSON.stringify(block.input, null, 2)}
          </pre>
        </div>
      );
    }

    // Tool result block
    if (block.type === "tool_result") {
      return (
        <div key={i} className="pretty-tool-result">
          <span className="pretty-tool-result-label">
            {block.isError ? "❌ Error" : "✓ Result"}
          </span>
          <pre className="json-view" style={{ margin: 0 }}>
            {JSON.stringify(block.content || block.result, null, 2)}
          </pre>
        </div>
      );
    }

    // Image block
    if (block.type === "image") {
      return (
        <div key={i} className="pretty-content-image">
          📷 Image
        </div>
      );
    }

    // Reasoning block
    if (block.type === "reasoning") {
      return (
        <div key={i} className="pretty-content-reasoning">
          <span className="pretty-reasoning-label">💭 Thinking</span>
          <div className="pretty-reasoning-text">{block.text}</div>
        </div>
      );
    }

    // Unknown - render as JSON
    return (
      <pre key={i} className="json-view" style={{ margin: 0 }}>
        {JSON.stringify(block, null, 2)}
      </pre>
    );
  });
}

// ============================================================================
// Context View - Shows per-tick context with pipeline visualization
// ============================================================================

function ContextView({
  execution,
  selectedTick = "latest",
}: {
  execution?: Execution;
  selectedTick?: number | "latest";
}) {
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

  // Context utilization - prefer real-time data from contextInfo over catalog lookup
  const contextInfo = tick.contextInfo;
  const modelId = contextInfo?.modelId || tick.model;
  const contextWindow = contextInfo?.contextWindow;
  const contextUtilization =
    contextInfo?.utilization ?? (modelId ? getContextUtilization(modelId, inputTokens) : undefined);
  // Fall back to catalog lookup if contextInfo doesn't have context window
  const modelInfo = contextWindow ? { contextWindow } : modelId ? getModelInfo(modelId) : undefined;

  // Get tool calls for this tick
  const toolCalls = tick.events.filter((e) => e.type === "tool_call");
  const toolResults = tick.events.filter((e) => e.type === "tool_result");

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
            {modelId || "—"}
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
        {/* Context Utilization Bar */}
        {modelInfo && contextUtilization !== undefined && (
          <div className="context-header-utilization">
            <div className="context-header-utilization-info">
              <span className="context-header-utilization-label">Context</span>
              <span className="context-header-utilization-value">
                {contextUtilization.toFixed(1)}% of {formatContextWindow(modelInfo.contextWindow)}
              </span>
            </div>
            <div className="context-utilization-bar-container">
              <div
                className="context-utilization-bar"
                style={{
                  width: `${Math.min(100, contextUtilization)}%`,
                  backgroundColor:
                    contextUtilization >= 90
                      ? "var(--accent-red)"
                      : contextUtilization >= 75
                        ? "var(--accent-orange)"
                        : contextUtilization >= 50
                          ? "var(--accent-yellow)"
                          : "var(--accent-green)",
                }}
              />
            </div>
          </div>
        )}
        {/* Model Capabilities and Cumulative Usage */}
        {contextInfo && (
          <div className="context-header-details">
            {contextInfo.provider && (
              <span className="context-badge provider">{contextInfo.provider}</span>
            )}
            {contextInfo.supportsVision && <span className="context-badge capability">Vision</span>}
            {contextInfo.supportsToolUse && <span className="context-badge capability">Tools</span>}
            {contextInfo.isReasoningModel && (
              <span className="context-badge capability">Reasoning</span>
            )}
            {contextInfo.cumulativeUsage && tick.number > 1 && (
              <span className="context-badge cumulative">
                Cumulative: {contextInfo.cumulativeUsage.totalTokens.toLocaleString()} tokens (
                {contextInfo.cumulativeUsage.ticks} ticks)
              </span>
            )}
          </div>
        )}
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

      {/* Request Pipeline */}
      <div className="pipeline-section">
        <h3 className="pipeline-title">Request Pipeline</h3>

        <PipelineStage
          number={1}
          title="Compiled Structure"
          subtitle="JSX → Semantic Blocks"
          data={tick.rawCompiled}
          dataType="compiled"
          defaultExpanded={false}
        />

        <PipelineStage
          number={2}
          title="Rendered Input"
          subtitle="After Markdown/XML"
          data={tick.formattedInput}
          dataType="rendered"
          defaultExpanded={false}
        />

        <PipelineStage
          number={3}
          title="Model Input"
          subtitle="Agentick Format"
          data={tick.modelInput}
          dataType="modelInput"
          defaultExpanded={true}
        />

        <PipelineStage
          number={4}
          title="Provider Input"
          subtitle="SDK Format"
          data={tick.providerInput}
          dataType="providerInput"
          defaultExpanded={false}
        />
      </div>

      {/* Response Pipeline */}
      <div className="pipeline-section">
        <h3 className="pipeline-title">Response Pipeline</h3>

        <PipelineStage
          number={1}
          title="Provider Output"
          subtitle="Raw SDK Response"
          data={tick.providerOutput}
          dataType="providerOutput"
          defaultExpanded={false}
        />

        <PipelineStage
          number={2}
          title="Model Output"
          subtitle="Normalized"
          data={tick.modelOutput}
          dataType="modelOutput"
          defaultExpanded={true}
        />

        <PipelineStage
          number={3}
          title="Engine State"
          subtitle="Timeline Integration"
          data={tick.engineState}
          dataType="engineState"
          defaultExpanded={false}
        />
      </div>

      {/* Tool Calls (if any) */}
      {toolCalls.length > 0 && (
        <div className="pipeline-section">
          <h3 className="pipeline-title">Tool Calls ({toolCalls.length})</h3>
          <div className="context-section">
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
  if (node.type === "agentick.fragment") {
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
  const isHostElement = node.type.startsWith("agentick.") || node.type === "text";

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
