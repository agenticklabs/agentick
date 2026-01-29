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
  /** Fiber tree snapshot at this tick */
  fiberTree?: FiberNode | null;
  /** Fiber summary at this tick */
  fiberSummary?: FiberSummary;
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

export interface Session {
  id: string;
  rootComponent: string;
  executions: string[]; // execution IDs
  totalUsage: UsageStats;
  latestFiberTree?: FiberNode | null;
  latestFiberSummary?: FiberSummary;
}

export function useDevToolsEvents() {
  const [executions, setExecutions] = useState<Map<string, Execution>>(new Map());
  const [sessions, setSessions] = useState<Map<string, Session>>(new Map());
  const [isConnected, setIsConnected] = useState(false);
  const seenEvents = useRef<Set<string>>(new Set());

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

        // Update execution (both the latest and per-tick)
        setExecutions((prev) => {
          const next = new Map(prev);
          const exec = next.get(event.executionId);
          if (exec) {
            next.set(event.executionId, {
              ...exec,
              fiberTree: tree,
              fiberSummary: summary,
              // Also store on the specific tick
              ticks: exec.ticks.map((t) =>
                t.number === tickNum
                  ? { ...t, fiberTree: tree, fiberSummary: summary }
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
                      events: [...t.events, { type: event.type, timestamp: event.timestamp, data: event }],
                    }
                  : t,
              ),
            });
          }
          return next;
        });
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
    seenEvents.current.clear();
    fetch("/api/clear").catch(() => {});
  }, []);

  // Convert maps to sorted arrays
  const executionList = Array.from(executions.values()).sort(
    (a, b) => b.startTime - a.startTime,
  );

  const sessionList = Array.from(sessions.values()).sort((a, b) => {
    // Sort by most recent execution
    const aLatest = Math.max(...a.executions.map((id) => executions.get(id)?.startTime ?? 0));
    const bLatest = Math.max(...b.executions.map((id) => executions.get(id)?.startTime ?? 0));
    return bLatest - aLatest;
  });

  return {
    executions: executionList,
    sessions: sessionList,
    isConnected,
    clearAll,
  };
}
