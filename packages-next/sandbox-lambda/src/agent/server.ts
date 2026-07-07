/**
 * The in-VM sandbox-agent HTTP + WebSocket server (ADR 60).
 *
 * This is the far-side "sandbox-agent" the `*-remote-next` convention
 * anticipates: AWS provides no in-guest agent, so we bake OURS into the
 * microVM image (Dockerfile `CMD`, default port 8080). It serves the
 * {@link SandboxHandle} contract ops against the local workspace filesystem:
 *   - `GET  /info`      → `{ workspacePath }` (also the readiness probe)
 *   - `POST /readFile`  → file content (or a typed-error envelope)
 *   - `POST /writeFile` → atomic write
 *   - `POST /editFile`  → in-VM `applyEdits`, atomic write-back
 *   - `WS   /exec`      → spawn `bash -c`, stream output frames, exit frame
 *
 * The agent does NOT validate the JWE `X-aws-proxy-auth` token — the Lambda
 * endpoint authenticates at the edge and strips the header before the agent
 * sees the request; loopback is reachable only on localhost. The agent trusts
 * inbound. When `networkRules` are supplied it starts an in-VM egress proxy
 * and injects `HTTP(S)_PROXY` into every exec env (domain-level enforcement
 * that Lambda's coarse VPC egress connectors cannot express).
 *
 * @see docs/proposals/v2/blueprint/60-remote-microvm-sandbox.md
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { NetworkRule, ProxiedRequest } from "@agentick/sandbox-next";
import { AgentEgressProxy } from "./egress-proxy.js";
import { runExec } from "./exec-runner.js";
import { agentEditFile, agentReadFile, agentWriteFile } from "./fs-ops.js";
import {
  type EditFileRequest,
  type ExecInitFrame,
  type ExecServerFrame,
  ROUTE_EDIT_FILE,
  ROUTE_EXEC,
  ROUTE_INFO,
  ROUTE_READ_FILE,
  ROUTE_WRITE_FILE,
  type ReadFileRequest,
  serializeSandboxError,
  type WriteFileRequest,
} from "../protocol.js";

/** Max request body the agent accepts (large-file write backstop): 64 MB. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface StartSandboxAgentOptions {
  /**
   * Workspace root inside the microVM. Default: `SANDBOX_WORKSPACE` env, then
   * the process cwd. In prod this is the image's fixed workspace path.
   */
  readonly workspace?: string;
  /** Bind port. Default 8080 (the Lambda default route target); 0 = ephemeral (tests). */
  readonly port?: number;
  /** Bind host. Default `"0.0.0.0"` (reachable through the endpoint); tests use loopback. */
  readonly host?: string;
  /**
   * Domain-level egress rules. When present, the agent starts an in-VM egress
   * proxy and injects `HTTP(S)_PROXY` into every exec env.
   */
  readonly networkRules?: readonly NetworkRule[];
  /**
   * Create-time base environment applied to EVERY exec (create-time
   * `SandboxCreateOptions.env`), beneath per-exec `env` overrides. Delivered
   * to the microVM via the `runHookPayload` (see the provider).
   */
  readonly baseEnv?: Readonly<Record<string, string>>;
  /** Audit hook for proxied requests (allowed + blocked). */
  readonly onProxiedRequest?: (req: ProxiedRequest) => void;
}

export interface SandboxAgent {
  /** The bound port. */
  readonly port: number;
  /** The resolved workspace root the agent serves. */
  readonly workspacePath: string;
  /** The in-VM egress proxy, if `networkRules` were supplied. */
  readonly egressProxy?: AgentEgressProxy;
  /** Stop the HTTP/WS server and the egress proxy. */
  close(): Promise<void>;
}

/**
 * Start the in-VM sandbox-agent. Returns once the HTTP server is listening
 * (and the egress proxy, if any, has started).
 *
 * @example
 * ```ts
 * import { startSandboxAgent } from "@agentick/sandbox-lambda-next/agent";
 *
 * const agent = await startSandboxAgent({ workspace: "/workspace", port: 8080 });
 * // ... serve the contract over the microVM endpoint ...
 * await agent.close();
 * ```
 */
export async function startSandboxAgent(
  options: StartSandboxAgentOptions = {},
): Promise<SandboxAgent> {
  const workspacePath = options.workspace ?? process.env.SANDBOX_WORKSPACE ?? process.cwd();
  const port = options.port ?? 8080;
  const host = options.host ?? "0.0.0.0";

  // Egress proxy — engaged only when a rule list is supplied.
  let egressProxy: AgentEgressProxy | undefined;
  if (options.networkRules && options.networkRules.length > 0) {
    egressProxy = new AgentEgressProxy(options.networkRules, {
      ...(options.onProxiedRequest ? { onProxiedRequest: options.onProxiedRequest } : {}),
    });
    await egressProxy.start();
  }

  const server = createServer((req, res) => {
    void handleHttp(req, res, workspacePath);
  });

  const baseEnv = options.baseEnv ?? {};

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== ROUTE_EXEC) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket as Socket, head, (ws) => {
      handleExec(ws, workspacePath, baseEnv, egressProxy);
    });
  });

  const boundPort = await new Promise<number>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    });
  });

  return {
    port: boundPort,
    workspacePath,
    ...(egressProxy ? { egressProxy } : {}),
    async close() {
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await egressProxy?.stop();
    },
  };
}

// ── HTTP request routing ─────────────────────────────────────────────────────

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  workspacePath: string,
): Promise<void> {
  const path = (req.url ?? "").split("?")[0];
  try {
    if (req.method === "GET" && path === ROUTE_INFO) {
      return sendJson(res, 200, { workspacePath });
    }
    if (req.method === "POST" && path === ROUTE_READ_FILE) {
      const body = await readBody<ReadFileRequest>(req);
      const content = await agentReadFile(body.path, workspacePath);
      return sendJson(res, 200, { content });
    }
    if (req.method === "POST" && path === ROUTE_WRITE_FILE) {
      const body = await readBody<WriteFileRequest>(req);
      await agentWriteFile(body.path, body.content, workspacePath);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && path === ROUTE_EDIT_FILE) {
      const body = await readBody<EditFileRequest>(req);
      const result = await agentEditFile(body.path, body.edits, workspacePath);
      return sendJson(res, 200, { result });
    }
    sendJson(res, 404, { error: serializeSandboxError(new Error(`no such route: ${path}`)) });
  } catch (err) {
    // Typed sandbox errors serialize into the envelope the client reconstructs.
    sendJson(res, 400, { error: serializeSandboxError(err) });
  }
}

// ── exec WebSocket handling ──────────────────────────────────────────────────

function handleExec(
  ws: WebSocket,
  workspacePath: string,
  baseEnv: Readonly<Record<string, string>>,
  egressProxy?: AgentEgressProxy,
): void {
  ws.once("message", (data) => {
    let init: ExecInitFrame;
    try {
      init = JSON.parse(data.toString()) as ExecInitFrame;
    } catch {
      send(ws, {
        type: "error",
        error: serializeSandboxError(new Error("malformed exec init frame")),
      });
      ws.close();
      return;
    }

    const env: Record<string, string> = {
      HOME: workspacePath,
      PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      TERM: "dumb",
      ...baseEnv,
    };
    if (egressProxy) {
      env.HTTP_PROXY = egressProxy.proxyUrl;
      env.http_proxy = egressProxy.proxyUrl;
      env.HTTPS_PROXY = egressProxy.proxyUrl;
      env.https_proxy = egressProxy.proxyUrl;
    }
    Object.assign(env, init.env ?? {});

    const controller = runExec({
      command: init.command,
      cwd: init.cwd ?? workspacePath,
      env,
      ...(init.stdin !== undefined ? { stdin: init.stdin } : {}),
      ...(init.timeoutMs !== undefined ? { timeoutMs: init.timeoutMs } : {}),
      onOutput: (frame) => send(ws, { type: "output", stream: frame.stream, chunk: frame.chunk }),
    });

    // The socket closing == an external abort → kill the process tree.
    ws.once("close", () => controller.abort());

    void controller.result.then((result) => {
      send(ws, {
        type: "exit",
        exitCode: result.exitCode,
        signaled: result.signaled,
        durationMs: result.durationMs,
      });
      ws.close();
    });
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────

function send(ws: WebSocket, frame: ExecServerFrame): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

function readBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (c: Buffer) => {
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error("request body exceeds 64MB limit"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()) as T);
      } catch (err) {
        reject(err instanceof Error ? err : new Error("malformed JSON body"));
      }
    });
    req.on("error", reject);
  });
}
