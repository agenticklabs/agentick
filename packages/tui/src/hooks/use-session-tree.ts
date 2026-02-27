/**
 * useSessionTree — builds a reactive tree of session nodes from stream events.
 *
 * Subscribes to the root session's event stream. Child session events
 * arrive with `spawnPath` — the first element identifies the spawn.
 * Events without `spawnPath` belong to the root session.
 */

import { useState, useEffect } from "react";
import { useEvents } from "@agentick/react";
import type {
  SpawnStartEvent,
  SpawnEndEvent,
  ToolCallStartEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "@agentick/shared";

export interface SessionTreeNode {
  spawnId: string;
  label: string;
  status: "running" | "done" | "error";
  currentTool?: { callId: string; name: string; summary?: string };
  toolCount: number;
  startedAt: number;
  duration?: number;
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

const EMPTY_TREE: SessionTreeState = {
  rootTool: undefined,
  rootToolCount: 0,
  spawns: [],
  hasActive: false,
};

export function useSessionTree(sessionId?: string): SessionTreeState {
  const [tree, setTree] = useState<SessionTreeState>(EMPTY_TREE);

  const { events } = useEvents({
    sessionId,
    filter: ["spawn_start", "spawn_end", "tool_call_start", "tool_call", "tool_result"],
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
      }

      return next;
    });
  }, [events]);

  // Clear completed spawns after all finish — same pattern as SpawnIndicator
  useEffect(() => {
    const allDone = tree.spawns.length > 0 && !tree.hasActive;
    if (allDone) {
      const timer = setTimeout(() => setTree(EMPTY_TREE), 3000);
      return () => clearTimeout(timer);
    }
  }, [tree.hasActive, tree.spawns.length]);

  return tree;
}
