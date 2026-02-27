/**
 * SessionTree — compact tree view of the spawn session graph.
 *
 * Shows each spawned agent with its current tool activity, tool count,
 * and completion status. The root session's tools are NOT shown here —
 * ToolCallIndicator handles those. This component is for the spawn graph.
 */

import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { useSessionTree } from "../hooks/use-session-tree.js";
import type { SessionTreeNode } from "../hooks/use-session-tree.js";
import { formatDuration } from "../rendering/index.js";

export interface SessionTreeProps {
  sessionId?: string;
}

function SpawnLine({ node, isLast }: { node: SessionTreeNode; isLast: boolean }) {
  const prefix = isLast ? "└─" : "├─";
  const leafPrefix = isLast ? "   └─ " : "│  └─ ";

  const isRunning = node.status === "running";
  const isDone = node.status === "done";

  const labelColor = isRunning ? "cyan" : node.status === "error" ? "red" : "gray";
  const toolCountText =
    node.toolCount > 0 ? ` · ${node.toolCount} tool${node.toolCount === 1 ? "" : "s"}` : "";

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text dimColor>{prefix}</Text>
        {isRunning ? (
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
        ) : isDone ? (
          <Text color="green">✓</Text>
        ) : (
          <Text color="red">✗</Text>
        )}
        <Text color={labelColor} dimColor={!isRunning}>
          {node.label}
          {toolCountText}
        </Text>
        {node.duration !== undefined && <Text dimColor>{formatDuration(node.duration)}</Text>}
      </Box>
      {isRunning && node.currentTool && (
        <Box>
          <Text dimColor>{leafPrefix}</Text>
          <Text color="cyan">{node.currentTool.summary ?? node.currentTool.name}</Text>
        </Box>
      )}
    </Box>
  );
}

export function SessionTree({ sessionId }: SessionTreeProps) {
  const tree = useSessionTree(sessionId);

  if (tree.spawns.length === 0) return null;

  const activeCount = tree.spawns.filter((s) => s.status === "running").length;

  return (
    <Box flexDirection="column" marginLeft={2}>
      {activeCount > 0 && (
        <Text color="cyan" bold>
          Running {activeCount} agent{activeCount === 1 ? "" : "s"}...
        </Text>
      )}
      {tree.spawns.map((node, i) => (
        <SpawnLine key={node.spawnId} node={node} isLast={i === tree.spawns.length - 1} />
      ))}
    </Box>
  );
}
