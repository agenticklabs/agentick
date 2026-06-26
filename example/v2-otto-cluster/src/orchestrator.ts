/**
 * Forks 3 worker processes, each running `worker.ts` with a distinct
 * NODE_ID + shared SOCKET_PATH. Parses each worker's stdout JSON lines
 * to track ready/sent/received/done events. Declares success when
 * every worker sees the other 2.
 *
 * Demonstrates the Phase 4 cluster wire end-to-end across REAL Node
 * processes (not in-process tests). The deployment shape this mimics:
 * PM2 fork-mode, or Node cluster module, on a single host.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build as esbuild } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerSrc = resolve(__dirname, "worker.ts");

interface WorkerLine {
  readonly nodeId?: string;
  readonly kind?: string;
  readonly [key: string]: unknown;
}

interface WorkerState {
  readonly nodeId: string;
  readonly child: ChildProcess;
  ready: boolean;
  sent: boolean;
  done: boolean;
  role?: string;
  received: Set<string>;
}

const NODES = ["node-A", "node-B", "node-C"];
const TIMEOUT_MS = 15_000;

const tmp = mkdtempSync(join(tmpdir(), "otto-cluster-"));
const socketPath = join(tmp, "cluster.sock");
const workerBundle = join(tmp, "worker.mjs");

const workers = new Map<string, WorkerState>();
let didCleanup = false;

function cleanup(code: number): void {
  if (didCleanup) return;
  didCleanup = true;
  for (const { child } of workers.values()) {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
  process.exit(code);
}

process.on("SIGINT", () => cleanup(130));
process.on("SIGTERM", () => cleanup(143));

function spawnWorker(nodeId: string, delayMs: number): void {
  setTimeout(() => {
    console.log(`[orch] spawning ${nodeId}`);
    // Run the pre-bundled worker JS. Bundling sidesteps a tsx + node 24
    // interaction where stderr buffers don't flush when a long-running
    // entry script imports workspace ESM packages (no boot output ever
    // reaches us). Bundling resolves all .ts → .js up front.
    const child = spawn(process.execPath, [workerBundle], {
      env: {
        ...process.env,
        NODE_ID: nodeId,
        SOCKET_PATH: socketPath,
        EXPECTED_NODES: String(NODES.length),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const state: WorkerState = {
      nodeId,
      child,
      ready: false,
      sent: false,
      done: false,
      received: new Set(),
    };
    workers.set(nodeId, state);

    let buf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line) as WorkerLine;
          handleWorkerEvent(state, evt);
        } catch {
          console.log(`[${nodeId}:raw] ${line}`);
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[${nodeId}:stderr] ${chunk.toString("utf8")}`);
    });
    child.on("error", (err) => {
      console.error(`[orch] ${nodeId} spawn error:`, err.message);
    });
    child.on("exit", (code, signal) => {
      console.log(`[orch] ${nodeId} exited code=${code} signal=${signal}`);
    });
  }, delayMs);
}

function handleWorkerEvent(state: WorkerState, evt: WorkerLine): void {
  const kind = evt.kind;
  switch (kind) {
    case "boot":
      console.log(`[${state.nodeId}] boot`);
      break;
    case "elect":
      state.role = String(evt.role);
      console.log(`[${state.nodeId}] elect=${state.role}`);
      break;
    case "broker-started":
      console.log(`[${state.nodeId}] broker started`);
      break;
    case "ready":
      state.ready = true;
      console.log(`[${state.nodeId}] ready (subscribed)`);
      break;
    case "sent":
      state.sent = true;
      console.log(`[${state.nodeId}] sent hello`);
      break;
    case "received":
      state.received.add(String(evt.from));
      console.log(`[${state.nodeId}] received hello from ${evt.from}`);
      break;
    case "done":
      state.done = true;
      console.log(`[${state.nodeId}] done — saw all peers`);
      checkAllDone();
      break;
    case "broadcast-failed":
    case "fatal":
      console.error(`[${state.nodeId}] ${kind}:`, evt.reason);
      break;
    case "diag":
      if (typeof evt.name === "string") {
        console.log(`[${state.nodeId}:diag] ${evt.name}`, evt.payload ?? "");
      }
      break;
    default:
      // shutting-down, others — ignore
      break;
  }
}

function checkAllDone(): void {
  for (const w of workers.values()) {
    if (!w.done) return;
  }
  console.log("\n[orch] ✓ all workers saw all peers. cluster healthy.");
  // Brief moment for clean shutdown logs to land.
  setTimeout(() => cleanup(0), 200);
}

async function bundleWorker(): Promise<void> {
  console.log(`[orch] bundling worker → ${workerBundle}`);
  await esbuild({
    entryPoints: [workerSrc],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: workerBundle,
    external: ["node:*"],
    logLevel: "error",
  });
  console.log(`[orch] worker bundle ready`);
}

async function main(): Promise<void> {
  await bundleWorker();
  console.log(`[orch] socket=${socketPath}, timeout=${TIMEOUT_MS}ms`);

  // Spawn workers with a small stagger so the first wins the bind race
  // deterministically.
  spawnWorker(NODES[0]!, 0);
  spawnWorker(NODES[1]!, 300);
  spawnWorker(NODES[2]!, 600);

  setTimeout(() => {
    console.error(`[orch] TIMEOUT after ${TIMEOUT_MS}ms — cluster did not converge`);
    for (const w of workers.values()) {
      console.error(
        `  ${w.nodeId}: role=${w.role ?? "?"} ready=${w.ready} sent=${w.sent} ` +
          `received=[${[...w.received].join(",")}] done=${w.done}`,
      );
    }
    cleanup(1);
  }, TIMEOUT_MS);
}

main().catch((err) => {
  console.error(`[orch] fatal: ${err instanceof Error ? err.message : String(err)}`);
  cleanup(1);
});
