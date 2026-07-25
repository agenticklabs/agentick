/**
 * Cluster worker — runs in a forked child process. Joins the cluster
 * via a shared Unix socket; first-to-bind becomes broker, rest are
 * clients (with auto-elect-on-broker-death wired in). Broadcasts a
 * hello, waits for every other peer's hello, exits clean.
 *
 * Stdout protocol with the orchestrator: every line is JSON. The
 * orchestrator parses `{kind: "ready"|"received"|"diag"|"done", ...}`
 * to track convergence.
 */

import { joinUnixCluster } from "@agentick/cluster-net";

const nodeId = process.env.NODE_ID;
const socketPath = process.env.SOCKET_PATH;
const expectedNodes = Number(process.env.EXPECTED_NODES ?? "3");

if (!nodeId || !socketPath) {
  console.error("worker: NODE_ID and SOCKET_PATH required");
  process.exit(1);
}

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ nodeId, ...payload })}\n`);
}

async function main(): Promise<void> {
  emit({ kind: "boot" });

  const node = await joinUnixCluster({
    nodeId: nodeId!,
    socketPath: socketPath!,
    onDiagnostic: (name, payload, layer) => emit({ kind: "diag", layer, name, payload }),
  });
  emit({ kind: "elect", role: node.role });
  if (node.localBrokerRunning()) emit({ kind: "broker-started" });

  // Collect cross-node hellos.
  const seenNodes = new Set<string>();
  node.bus.subscribe("otto:hello", (env) => {
    const fromNode = env.scope.nodeId;
    if (fromNode && fromNode !== nodeId && !seenNodes.has(fromNode)) {
      seenNodes.add(fromNode);
      emit({ kind: "received", from: fromNode });
      if (seenNodes.size >= expectedNodes - 1) {
        emit({ kind: "done", seen: [...seenNodes] });
      }
    }
  });
  emit({ kind: "ready" });

  // Wait until every peer is in membership before broadcasting once.
  // Beats hand-rolling a retry loop and eliminates the
  // "broadcast-before-subscribers-joined" race.
  await node.membership.waitForPeers(expectedNodes - 1, { timeoutMs: 10_000 });
  await node.bus.broadcast("otto:hello");
  emit({ kind: "sent" });

  const shutdown = async (): Promise<void> => {
    emit({ kind: "shutting-down" });
    await node.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err) => {
  emit({
    kind: "fatal",
    reason: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
