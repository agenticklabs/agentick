/**
 * SessionTree — compact tree view of the spawn session graph.
 *
 * Shows each spawned agent with its current tool activity, tool count,
 * model info, context utilization, and completion status. The root
 * session's tools are NOT shown here — ToolCallIndicator handles those.
 */

import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { useSessionTree } from "../hooks/use-session-tree.js";
import type { SessionTreeNode } from "../hooks/use-session-tree.js";
import { formatDuration } from "../rendering/index.js";

export interface SessionTreeProps {
  sessionId?: string;
  /** External tree state. When provided, the component skips calling useSessionTree. */
  tree?: { spawns: SessionTreeNode[]; hasActive: boolean };
}

function shortModelName(name?: string): string | undefined {
  if (!name) return undefined;
  // Strip common prefixes: "claude-3-5-sonnet-20241022" → "sonnet"
  // "gpt-4o-2024-08-06" → "gpt-4o"
  const lower = name.toLowerCase();
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("opus")) return "opus";
  if (lower.includes("haiku")) return "haiku";
  if (lower.includes("gpt-4o")) return "gpt-4o";
  if (lower.includes("gpt-4")) return "gpt-4";
  // Fallback: use the name as-is but truncate
  return name.length > 12 ? name.slice(0, 12) : name;
}

function utilizationColor(util: number): string {
  if (util > 80) return "red";
  if (util > 50) return "yellow";
  return "green";
}

function SpawnLine({ node, isLast }: { node: SessionTreeNode; isLast: boolean }) {
  const prefix = isLast ? "└─" : "├─";
  const leafPrefix = isLast ? "   └─ " : "│  └─ ";

  const isRunning = node.status === "running";
  const isDone = node.status === "done";

  const labelColor = isRunning ? "cyan" : node.status === "error" ? "red" : "gray";
  const toolCountText =
    node.toolCount > 0 ? ` · ${node.toolCount} tool${node.toolCount === 1 ? "" : "s"}` : "";

  const model = shortModelName(node.modelName ?? node.modelId);
  const modelText = model ? ` [${model}]` : "";

  const utilText = node.utilization != null ? ` · ctx ${Math.round(node.utilization)}%` : "";
  const utilColor = node.utilization != null ? utilizationColor(node.utilization) : "gray";

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
          <Text dimColor>{modelText}</Text>
          {toolCountText}
          {utilText && <Text color={utilColor}>{utilText}</Text>}
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

export function SessionTree({ sessionId, tree: externalTree }: SessionTreeProps) {
  const internalTree = useSessionTree(sessionId);
  const { spawns } = externalTree ?? internalTree;

  if (spawns.length === 0) return null;

  const activeCount = spawns.filter((s) => s.status === "running").length;

  return (
    <Box flexDirection="column" marginLeft={2}>
      {activeCount > 0 && (
        <Text color="cyan" bold>
          Running {activeCount} agent{activeCount === 1 ? "" : "s"}...
        </Text>
      )}
      {spawns.map((node, i) => (
        <SpawnLine key={node.spawnId} node={node} isLast={i === spawns.length - 1} />
      ))}
    </Box>
  );
}
