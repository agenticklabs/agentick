import { useState, useEffect, useCallback, useRef } from "react";

// Types matching @tentickle/shared DevToolsEvent
interface DevToolsEvent {
  type: string;
  executionId: string;
  sequence: number;
  timestamp: number;
  sessionId?: string;
  tick?: number;
  [key: string]: unknown;
}

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface Tick {
  number: number;
  events: TickEvent[];
  content: string;
  usage?: UsageStats;
  model?: string;
  startTime: number;
  endTime?: number;
  /** Compiled context (after JSX compilation) */
  compiled?: {
    messages: unknown[];
    tools: unknown[];
    system?: string;
  };
  /** Provider-formatted model request */
  modelRequest?: unknown;
  /** Raw provider response */
  providerResponse?: unknown;
  /** Transformed model output (engine format) */
  modelOutput?: unknown;
  /** COM layer output (final combined output) */
  comOutput?: unknown;
  /** Fiber tree snapshot at this tick */
  fiberTree?: FiberNode | null;
  /** Fiber summary at this tick */
  fiberSummary?: FiberSummary;
  /** Token estimates at this tick */
  tokenSummary?: TokenSummary;
  /** Compiled structure preview at this tick */
  compiledPreview?: CompiledPreview;
}

export interface TickEvent {
  type: string;
  timestamp: number;
  data: unknown;
}

export interface Execution {
  id: string;
  sessionId?: string;
  rootComponent: string;
  status: "running" | "completed" | "error";
  ticks: Tick[];
  totalUsage?: UsageStats;
  startTime: number;
  endTime?: number;
  model?: string;
  fiberTree?: FiberNode | null;
  fiberSummary?: FiberSummary;
  /** Latest token estimates */
  tokenSummary?: TokenSummary;
  /** Latest compiled preview */
  compiledPreview?: CompiledPreview;
}

export interface FiberNode {
  id: string;
  type: string;
  key: string | number | null;
  props: Record<string, unknown>;
  hooks: HookState[];
  children: FiberNode[];
  /** Human-readable summary for display */
  _summary?: string;
}

export interface HookState {
  index: number;
  type: string;
  value: unknown;
  deps?: unknown[];
  status?: string;
}

export interface FiberSummary {
  componentCount: number;
  hookCount: number;
  hooksByType: Record<string, number>;
}

export interface TokenSummary {
  system: number;
  messages: number;
  tools: number;
  ephemeral: number;
  total: number;
  byComponent?: Record<string, number>;
}

export interface CompiledPreview {
  systemPrompt?: string;
  messageCount: number;
  toolCount: number;
  ephemeralCount: number;
}

export interface Session {
  id: string;
  rootComponent: string;
  executions: string[]; // execution IDs
  totalUsage: UsageStats;
  latestFiberTree?: FiberNode | null;
  latestFiberSummary?: FiberSummary;
}

// Network monitoring types
export interface ClientInfo {
  id: string;
  transport: "websocket" | "sse" | "http";
  connectedAt: number;
  ip?: string;
  userAgent?: string;
}

export interface GatewaySessionInfo {
  id: string;
  appId: string;
  messageCount: number;
  createdAt: number;
  clientId?: string;
}

export interface RequestInfo {
  id: string;
  method: string;
  params?: Record<string, unknown>;
  timestamp: number;
  latencyMs?: number;
  ok?: boolean;
  error?: string;
  sessionKey?: string;
  clientId?: string;
}

export function useDevToolsEvents() {
  const [executions, setExecutions] = useState<Map<string, Execution>>(new Map());
  const [sessions, setSessions] = useState<Map<string, Session>>(new Map());
  const [isConnected, setIsConnected] = useState(false);
  const seenEvents = useRef<Set<string>>(new Set());

  // Network state
  const [clients, setClients] = useState<Map<string, ClientInfo>>(new Map());
  const [gatewaySessions, setGatewaySessions] = useState<Map<string, GatewaySessionInfo>>(
    new Map(),
  );
  const [requests, setRequests] = useState<RequestInfo[]>([]);

  const getEventKey = (event: DevToolsEvent): string => {
    // Use sequence number for deduplication - monotonically increasing per session,
    // guaranteed unique. Include type to handle cases where multiple DevTools events
    // are derived from a single source event (e.g., model_response + provider_response).
    return `${event.executionId}:${event.type}:${event.sequence}`;
  };

  const processEvent = useCallback((event: DevToolsEvent) => {
    const key = getEventKey(event);
    if (seenEvents.current.has(key)) return;
    seenEvents.current.add(key);

    switch (event.type) {
      case "execution_start": {
        const sessionId = event.sessionId as string | undefined;
        const rootComponent = (event.rootComponent as string) || "Unknown";

        setExecutions((prev) => {
          const next = new Map(prev);
          next.set(event.executionId, {
            id: event.executionId,
            sessionId,
            rootComponent,
            status: "running",
            ticks: [],
            startTime: event.timestamp,
          });
          return next;
        });

        // Update session
        if (sessionId) {
          setSessions((prev) => {
            const next = new Map(prev);
            const existing = next.get(sessionId);
            if (existing) {
              next.set(sessionId, {
                ...existing,
                executions: [...existing.executions, event.executionId],
              });
            } else {
              next.set(sessionId, {
                id: sessionId,
                rootComponent,
                executions: [event.executionId],
                totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              });
            }
            return next;
          });
        }
        break;
      }

      case "execution_end": {
        setExecutions((prev) => {
          const next = new Map(prev);
          const exec = next.get(event.executionId);
          if (exec) {
            next.set(event.executionId, {
              ...exec,
              status: "completed",
              endTime: event.timestamp,
              totalUsage: event.totalUsage as UsageStats | undefined,
            });
          }
          return next;
        });
        break;
      }

      case "tick_start": {
        const tickNum = event.tick as number;
        setExecutions((prev) => {
          const next = new Map(prev);
          const exec = next.get(event.executionId);
          if (exec && !exec.ticks.some((t) => t.number === tickNum)) {
            next.set(event.executionId, {
              ...exec,
              ticks: [
                ...exec.ticks,
                {
                  number: tickNum,
                  events: [],
                  content: "",
                  startTime: event.timestamp,
                },
              ],
            });
          }
          return next;
        });
        break;
      }

      case "tick_end": {
        const tickNum = event.tick as number;
        setExecutions((prev) => {
          const next = new Map(prev);
          const exec = next.get(event.executionId);
          if (exec) {
            next.set(event.executionId, {
              ...exec,
              ticks: exec.ticks.map((t) =>
                t.number === tickNum
                  ? {
                      ...t,
                      endTime: event.timestamp,
                      usage: (event.usage as UsageStats) || t.usage,
                      model: (event.model as string) || t.model,
                    }
                  : t,
              ),
            });
          }
          return next;
        });
        break;
      }

      case "fiber_snapshot": {
        const sessionId = event.sessionId as string;
        const tickNum = event.tick as number;
        const tree = event.tree as FiberNode | null;
        const summary = event.summary as FiberSummary;
        const tokenSummary = event.tokenSummary as TokenSummary | undefined;
        const compiledPreview = event.compiledPreview as CompiledPreview | undefined;

        // Update execution (both the latest and per-tick)
        setExecutions((prev) => {
          const next = new Map(prev);
          const exec = next.get(event.executionId);
          if (exec) {
            next.set(event.executionId, {
              ...exec,
              fiberTree: tree,
              fiberSummary: summary,
              tokenSummary,
              compiledPreview,
              // Also store on the specific tick
              ticks: exec.ticks.map((t) =>
                t.number === tickNum
                  ? { ...t, fiberTree: tree, fiberSummary: summary, tokenSummary, compiledPreview }
                  : t,
              ),
            });
          }
          return next;
        });

        // Update session with latest fiber state
        if (sessionId) {
          setSessions((prev) => {
            const next = new Map(prev);
            const session = next.get(sessionId);
            if (session) {
              next.set(sessionId, {
                ...session,
                latestFiberTree: tree,
                latestFiberSummary: summary,
              });
            }
            return next;
          });
        }
        break;
      }

      case "content_delta": {
        const tickNum = event.tick as number;
        const delta = event.delta as string;
        setExecutions((prev) => {
          const next = new Map(prev);
          const exec = next.get(event.executionId);
          if (exec) {
            next.set(event.executionId, {
              ...exec,
              ticks: exec.ticks.map((t) =>
                t.number === tickNum
                  ? {
                      ...t,
                      content: t.content + delta,
                      events: [
                        ...t.events,
                        { type: "content_delta", timestamp: event.timestamp, data: delta },
                      ],
                    }
                  : t,
              ),
            });
          }
          return next;
        });
        break;
      }

      case "compiled": {
        const tickNum = event.tick as number;
        setExecutions((prev) => {
          const next = new Map(prev);
          const exec = next.get(event.executionId);
          if (exec) {
            next.set(event.executionId, {
              ...exec,
              ticks: exec.ticks.map((t) =>
                t.number === tickNum
                  ? {
                      ...t,
                      compiled: {
                        messages: event.messages as unknown[],
                        tools: event.tools as unknown[],
                        system: event.system as string | undefined,
                      },
                    }
                  : t,
              ),
            });
          }
          return next;
        });
        break;
      }

      case "model_request": {
        const tickNum = event.tick as number;
        setExecutions((prev) => {
          const next = new Map(prev);
          const exec = next.get(event.executionId);
          if (exec) {
            next.set(event.executionId, {
              ...exec,
              ticks: exec.ticks.map((t) =>
                t.number === tickNum
                  ? {
                      ...t,
                      modelRequest: event.input,
                    }
                  : t,
              ),
            });
          }
          return next;
        });
        break;
      }

      case "model_response": {
        const tickNum = event.tick as number;
        setExecutions((prev) => {
          const next = new Map(prev);
          const exec = next.get(event.executionId);
          if (exec) {
            next.set(event.executionId, {
              ...exec,
              ticks: exec.ticks.map((t) =>
                t.number === tickNum
                  ? {
                      ...t,
                      modelOutput: event.message,
                    }
                  : t,
              ),
            });
          }
          return next;
        });
        break;
      }

      case "provider_response": {
        const tickNum = event.tick as number;
        setExecutions((prev) => {
          const next = new Map(prev);
          const exec = next.get(event.executionId);
          if (exec) {
            next.set(event.executionId, {
              ...exec,
              ticks: exec.ticks.map((t) =>
                t.number === tickNum
                  ? {
                      ...t,
                      providerResponse: event.providerOutput,
                    }
                  : t,
              ),
            });
          }
          return next;
        });
        break;
      }

      case "tool_call":
      case "tool_result": {
        const tickNum = event.tick as number;
        setExecutions((prev) => {
          const next = new Map(prev);
          const exec = next.get(event.executionId);
          if (exec) {
            next.set(event.executionId, {
              ...exec,
              ticks: exec.ticks.map((t) =>
                t.number === tickNum
                  ? {
                      ...t,
                      events: [
                        ...t.events,
                        { type: event.type, timestamp: event.timestamp, data: event },
                      ],
                    }
                  : t,
              ),
            });
          }
          return next;
        });
        break;
      }

      // Network events
      case "client_connected": {
        const clientInfo: ClientInfo = {
          id: event.clientId as string,
          transport: event.transport as "websocket" | "sse" | "http",
          connectedAt: event.timestamp,
          ip: event.ip as string | undefined,
          userAgent: event.userAgent as string | undefined,
        };
        setClients((prev) => {
          const next = new Map(prev);
          next.set(clientInfo.id, clientInfo);
          return next;
        });
        break;
      }

      case "client_disconnected": {
        const clientId = event.clientId as string;
        setClients((prev) => {
          const next = new Map(prev);
          next.delete(clientId);
          return next;
        });
        break;
      }

      case "gateway_session": {
        const action = event.action as string;
        const sessionId = event.sessionId as string;
        if (action === "created" || action === "message" || action === "resumed") {
          const sessionInfo: GatewaySessionInfo = {
            id: sessionId,
            appId: event.appId as string,
            messageCount: (event.messageCount as number) ?? 0,
            createdAt: event.timestamp,
            clientId: event.clientId as string | undefined,
          };
          setGatewaySessions((prev) => {
            const next = new Map(prev);
            const existing = next.get(sessionId);
            if (existing && action === "message") {
              // Update message count
              next.set(sessionId, { ...existing, messageCount: sessionInfo.messageCount });
            } else {
              next.set(sessionId, sessionInfo);
            }
            return next;
          });
        } else if (action === "closed") {
          setGatewaySessions((prev) => {
            const next = new Map(prev);
            next.delete(sessionId);
            return next;
          });
        }
        break;
      }

      case "gateway_request": {
        const requestInfo: RequestInfo = {
          id: event.requestId as string,
          method: event.method as string,
          params: event.params as Record<string, unknown> | undefined,
          timestamp: event.timestamp,
          sessionKey: event.sessionKey as string | undefined,
          clientId: event.clientId as string | undefined,
        };
        setRequests((prev) => [...prev.slice(-99), requestInfo]); // Keep last 100 requests
        break;
      }

      case "gateway_response": {
        const requestId = event.requestId as string;
        setRequests((prev) =>
          prev.map((req) =>
            req.id === requestId
              ? {
                  ...req,
                  latencyMs: event.latencyMs as number,
                  ok: event.ok as boolean,
                  error: event.error ? (event.error as { message: string }).message : undefined,
                }
              : req,
          ),
        );
        break;
      }
    }
  }, []);

  // Fetch history and subscribe to SSE
  useEffect(() => {
    // Fetch history
    fetch("/api/history")
      .then((res) => res.json())
      .then((events: DevToolsEvent[]) => {
        for (const event of events) {
          processEvent(event);
        }
      })
      .catch(() => {});

    // SSE connection
    const es = new EventSource("/events");

    es.onopen = () => setIsConnected(true);
    es.onerror = () => setIsConnected(false);

    es.onmessage = (e) => {
      const event = JSON.parse(e.data);
      if (event.type === "connected") {
        setIsConnected(true);
        return;
      }
      processEvent(event);
    };

    return () => es.close();
  }, [processEvent]);

  const clearAll = useCallback(() => {
    setExecutions(new Map());
    setSessions(new Map());
    setClients(new Map());
    setGatewaySessions(new Map());
    setRequests([]);
    seenEvents.current.clear();
    fetch("/api/clear").catch(() => {});
  }, []);

  // Convert maps to sorted arrays
  const executionList = Array.from(executions.values()).sort((a, b) => b.startTime - a.startTime);

  const sessionList = Array.from(sessions.values()).sort((a, b) => {
    // Sort by most recent execution
    const aLatest = Math.max(...a.executions.map((id) => executions.get(id)?.startTime ?? 0));
    const bLatest = Math.max(...b.executions.map((id) => executions.get(id)?.startTime ?? 0));
    return bLatest - aLatest;
  });

  // Convert network maps to arrays
  const clientList = Array.from(clients.values()).sort((a, b) => b.connectedAt - a.connectedAt);
  const gatewaySessionList = Array.from(gatewaySessions.values()).sort(
    (a, b) => b.createdAt - a.createdAt,
  );

  return {
    executions: executionList,
    sessions: sessionList,
    isConnected,
    clearAll,
    // Network state
    clients: clientList,
    gatewaySessions: gatewaySessionList,
    requests,
  };
}
