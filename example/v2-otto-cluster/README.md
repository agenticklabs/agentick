# example-v2-otto-cluster

Phase 4 cluster proof-point. Spawns 3 worker processes that coordinate
via a Unix-socket cluster with auto-elect + re-election. No Docker, no
real model — purely demonstrates the **single-host multi-worker
deployment tier** end-to-end across real `child_process.fork`-spawned
Node processes.

This is the deployment shape an adopter would use with PM2 fork-mode
or Node's built-in `cluster` module on a single large host.

## Run

```bash
pnpm --filter example-v2-otto-cluster dev
```

Expected output (process names + roles):

```
[orch] socket=/tmp/otto-cluster-XYZ/cluster.sock, timeout=15000ms
[orch] spawning node-A
[node-A] boot
[node-A] elect=broker      ← won the bind race
[node-A] broker started
[node-A] ready (subscribed)
[orch] spawning node-B
[node-B] boot
[node-B] elect=client      ← lost the bind race, connects as client
[node-B] ready (subscribed)
[orch] spawning node-C
[node-C] boot
[node-C] elect=client
[node-C] ready (subscribed)
[node-A] sent hello
[node-B] sent hello
[node-C] sent hello
[node-A] received hello from node-B
[node-A] received hello from node-C
[node-B] received hello from node-A
[node-B] received hello from node-C
[node-C] received hello from node-A
[node-C] received hello from node-B
[node-A] done — saw all peers
[node-B] done — saw all peers
[node-C] done — saw all peers

[orch] ✓ all workers saw all peers. cluster healthy.
```

## What it proves

- **Cross-process cluster wire works.** Three real Node processes
  exchange broadcasts via the cluster — not in-process testing.
- **Auto-elect via `tryBindOrConnectUnix`.** First worker wins the
  bind race + becomes broker; subsequent workers see EADDRINUSE +
  connect as clients.
- **Bus broadcast fan-out.** A `terminal`-phase event on one node's
  bus lands at every other node's subscription.
- **Graceful shutdown.** SIGTERM from the orchestrator triggers
  `node.close()` → flush Goodbye → tear down broker.

## What it doesn't demonstrate (deferred)

- **Real-Redis multi-host.** Use `defineRedisCluster` from
  `@agentick/cluster-redis-next` against an actual Redis instance.
  Requires docker-compose; Phase 5+.
- **Broker re-election under fault injection.** The
  `unix-re-election.spec.ts` test pins this in-process; the demo
  could exercise it by killing the broker worker and watching a
  client take over. Future improvement.
- **A real model talking through the cluster.** Out of scope —
  the model-side is `example/v2-otto`; this demo is the wire-side
  proof.

## Design notes

The worker uses `electableUnixClusterNode` for the client side so it
gets automatic re-election if the broker dies. The broker-elected
worker runs BOTH `unixBroker(...)` and `electableUnixClusterNode(...)`
— it's both serving and participating.

JSON-line stdout protocol between worker and orchestrator: every
worker line is a `{kind: "...", ...}` object. The orchestrator
parses + tracks state. This is the pattern most production orches‐
trators (PM2, systemd, k8s logs) consume; demo mirrors that.
