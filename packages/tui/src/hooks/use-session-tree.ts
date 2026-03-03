/**
 * useSessionTree — builds a reactive tree of session nodes from stream events.
 *
 * Subscribes to the root session's event stream. Child session events
 * arrive with `spawnPath` — the first element identifies the spawn.
 * Events without `spawnPath` belong to the root session.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useEvents } from "@agentick/react";
import type {
  SpawnStartEvent,
  SpawnEndEvent,
  ToolCallStartEvent,
  ToolCallEvent,
  ToolResultEvent,
  ContextUpdateEvent,
} from "@agentick/shared";

export interface SessionTreeNode {
  spawnId: string;
  label: string;
  status: "running" | "done" | "error";
  currentTool?: { callId: string; name: string; summary?: string };
  toolCount: number;
  startedAt: number;
  duration?: number;
  modelId?: string;
  modelName?: string;
  utilization?: number;
  cacheHitRatio?: number;
  tick?: number;
}

export interface SessionTreeState {
  /** Current tool activity on the root session (no spawnPath) */
  rootTool?: { callId: string; name: string; summary?: string };
  rootToolCount: number;
  /** Spawned child agents */
  spawns: SessionTreeNode[];
  /** Whether any spawn is still running */
  hasActive: boolean;
}

export interface SessionTreeResult extends SessionTreeState {
  /** Clear the tree. Call when the user submits a new message. */
  clearTree: () => void;
}

const EMPTY_TREE: SessionTreeState = {
  rootTool: undefined,
  rootToolCount: 0,
  spawns: [],
  hasActive: false,
};

export function useSessionTree(sessionId?: string): SessionTreeResult {
  const [tree, setTree] = useState<SessionTreeState>(EMPTY_TREE);
  const treeRef = useRef(tree);
  treeRef.current = tree;

  const { events } = useEvents({
    sessionId,
    filter: [
      "spawn_start",
      "spawn_end",
      "tool_call_start",
      "tool_call",
      "tool_result",
      "context_update",
    ],
  });

  useEffect(() => {
    if (events.length === 0) return;

    setTree((prev) => {
      let next = prev;

      for (const event of events) {
        // Route: events with spawnPath belong to a child spawn,
        // events without belong to the root session.
        const spawnId = event.spawnPath?.[0];

        if (event.type === "spawn_start") {
          const e = event as SpawnStartEvent;
          if (next.spawns.find((s) => s.spawnId === e.spawnId)) continue;
          const node: SessionTreeNode = {
            spawnId: e.spawnId,
            label: e.label ?? e.componentName ?? "agent",
            status: "running",
            toolCount: 0,
            startedAt: Date.now(),
          };
          next = {
            ...next,
            spawns: [...next.spawns, node],
            hasActive: true,
          };
          continue;
        }

        if (event.type === "spawn_end") {
          const e = event as SpawnEndEvent;
          const updated = next.spawns.map((s) =>
            s.spawnId === e.spawnId
              ? {
                  ...s,
                  status: (e.isError ? "error" : "done") as SessionTreeNode["status"],
                  duration: Date.now() - s.startedAt,
                  currentTool: undefined,
                }
              : s,
          );
          next = {
            ...next,
            spawns: updated,
            hasActive: updated.some((s) => s.status === "running"),
          };
          continue;
        }

        if (event.type === "tool_call_start" || event.type === "tool_call") {
          const e = event as ToolCallStartEvent | ToolCallEvent;
          const callId = e.callId ?? "unknown";
          const name = e.name ?? "tool";
          const summary = event.type === "tool_call" ? (e as ToolCallEvent).summary : undefined;
          const tool = { callId, name, summary };

          if (!spawnId) {
            next = { ...next, rootTool: tool };
          } else {
            next = {
              ...next,
              spawns: next.spawns.map((s) =>
                s.spawnId === spawnId ? { ...s, currentTool: tool } : s,
              ),
            };
          }
          continue;
        }

        if (event.type === "tool_result") {
          const e = event as ToolResultEvent;
          const callId = e.callId ?? "unknown";

          if (!spawnId) {
            next = {
              ...next,
              rootTool: next.rootTool?.callId === callId ? undefined : next.rootTool,
              rootToolCount: next.rootToolCount + 1,
            };
          } else {
            next = {
              ...next,
              spawns: next.spawns.map((s) =>
                s.spawnId === spawnId
                  ? {
                      ...s,
                      toolCount: s.toolCount + 1,
                      currentTool: s.currentTool?.callId === callId ? undefined : s.currentTool,
                    }
                  : s,
              ),
            };
          }
          continue;
        }

        if (event.type === "context_update") {
          // context_update events with spawnPath carry per-agent model info
          if (!spawnId) continue;
          const e = event as ContextUpdateEvent;
          next = {
            ...next,
            spawns: next.spawns.map((s) =>
              s.spawnId === spawnId
                ? {
                    ...s,
                    modelId: e.modelId,
                    modelName: e.modelName,
                    utilization: e.utilization,
                    cacheHitRatio: e.cacheHitRatio,
                    tick: event.tick,
                  }
                : s,
            ),
          };
          continue;
        }
      }

      return next;
    });
  }, [events]);

  const clearTree = useCallback(() => {
    setTree(EMPTY_TREE);
  }, []);

  return { ...tree, clearTree };
}
