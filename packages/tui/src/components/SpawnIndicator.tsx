/**
 * SpawnIndicator — shows spawn execution feedback.
 *
 * Shows a spinner + agent name during execution,
 * completed/error indicator when done.
 */

import { useState, useEffect } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { useEvents } from "@agentick/react";
import type { SpawnStartEvent, SpawnEndEvent } from "@agentick/shared";
import { formatDuration } from "../rendering/index.js";

interface ActiveSpawn {
  spawnId: string;
  name: string;
  status: "running" | "done" | "error";
  startedAt: number;
  duration?: number;
}

interface SpawnIndicatorProps {
  sessionId?: string;
}

export function SpawnIndicator({ sessionId }: SpawnIndicatorProps) {
  const [spawns, setSpawns] = useState<ActiveSpawn[]>([]);
  const { event } = useEvents({
    sessionId,
    filter: ["spawn_start", "spawn_end"],
  });

  useEffect(() => {
    if (!event) return;

    if (event.type === "spawn_start") {
      const e = event as SpawnStartEvent;
      const name = e.label ?? e.componentName ?? "agent";
      setSpawns((prev) => {
        if (prev.find((s) => s.spawnId === e.spawnId)) return prev;
        return [...prev, { spawnId: e.spawnId, name, status: "running", startedAt: Date.now() }];
      });
    }

    if (event.type === "spawn_end") {
      const e = event as SpawnEndEvent;
      setSpawns((prev) =>
        prev.map((s) =>
          s.spawnId === e.spawnId
            ? { ...s, status: e.isError ? "error" : "done", duration: Date.now() - s.startedAt }
            : s,
        ),
      );
    }
  }, [event]);

  // Clean up completed spawns after a short delay
  useEffect(() => {
    const allDone = spawns.length > 0 && spawns.every((s) => s.status !== "running");
    if (allDone) {
      const timer = setTimeout(() => setSpawns([]), 2000);
      return () => clearTimeout(timer);
    }
  }, [spawns]);

  if (spawns.length === 0) return null;

  return (
    <Box flexDirection="column" marginLeft={2}>
      {spawns.map((spawn) => (
        <Box key={spawn.spawnId} gap={1} flexDirection="row">
          {spawn.status === "running" ? (
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
          ) : spawn.status === "error" ? (
            <Text color="red">✗</Text>
          ) : (
            <Text color="green">✓</Text>
          )}
          <Text
            color={spawn.status === "running" ? "cyan" : spawn.status === "error" ? "red" : "gray"}
            dimColor={spawn.status !== "running"}
          >
            {spawn.name}
          </Text>
          {spawn.duration !== undefined && <Text dimColor>{formatDuration(spawn.duration)}</Text>}
        </Box>
      ))}
    </Box>
  );
}
