/**
 * `EndpointClient` — the near-side HTTP+WebSocket client that reaches the
 * in-VM sandbox-agent over the microVM endpoint (ADR 60).
 *
 * Each {@link SandboxHandle} op becomes a request to the agent: fs ops are
 * request/response JSON over HTTP(S); `exec` opens a WebSocket, maps output
 * frames to `onOutput`, and assembles the authoritative
 * `SandboxExecResult` from the streamed frames + the terminal exit frame.
 *
 * ## Auth (credentials-never-cross-wire)
 * When a JWE `token` is set (real Lambda), every request carries
 * `X-aws-proxy-auth: <token>` and `X-aws-proxy-port: <port>` (the in-VM
 * target port). The token is a SERVER-SIDE capability minted by the provider
 * via `create-microvm-auth-token`; it is passed to this client (which also
 * lives server-side) and never projected to the browser. A `null` token means
 * loopback / direct mode (tests hitting `http://127.0.0.1:<port>`) — no auth
 * headers are attached.
 *
 * @see docs/proposals/v2/blueprint/60-remote-microvm-sandbox.md
 */

import { WebSocket } from "ws";
import type {
  SandboxEdit,
  SandboxEditResult,
  SandboxExecOptions,
  SandboxExecResult,
} from "@agentick/sandbox-next";
import {
  AUTH_TOKEN_MAP_KEY,
  deserializeSandboxError,
  type AgentErrorBody,
  type EditFileResponse,
  type ExecInitFrame,
  type ExecServerFrame,
  HEADER_PROXY_AUTH,
  HEADER_PROXY_PORT,
  type InfoResponse,
  type ReadFileResponse,
  ROUTE_EDIT_FILE,
  ROUTE_EXEC,
  ROUTE_INFO,
  ROUTE_READ_FILE,
  ROUTE_WRITE_FILE,
} from "./protocol.js";

export interface EndpointClientConfig {
  /** Base endpoint URL (e.g. `https://<id>.lambda-microvm.<region>.on.aws` or `http://127.0.0.1:<port>`). */
  readonly endpoint: string;
  /** In-VM target port behind the endpoint (for `X-aws-proxy-port`). Default 8080. */
  readonly port?: number;
  /**
   * JWE bearer token. Non-empty string → real Lambda (attach auth headers);
   * `null`/`undefined` → loopback / direct (no headers). Server-side only.
   */
  readonly token?: string | null;
}

export { AUTH_TOKEN_MAP_KEY };

export class EndpointClient {
  private readonly base: string;
  private readonly port: number;
  private readonly token: string | null;

  constructor(config: EndpointClientConfig) {
    // Strip a trailing slash so route concatenation is clean.
    this.base = config.endpoint.replace(/\/+$/, "");
    this.port = config.port ?? 8080;
    this.token = config.token ?? null;
  }

  /** Fetch the agent's workspace root — also the readiness probe. */
  async info(): Promise<InfoResponse> {
    return this.get<InfoResponse>(ROUTE_INFO);
  }

  async readFile(path: string): Promise<string> {
    const body = await this.post<ReadFileResponse>(ROUTE_READ_FILE, { path });
    return body.content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.post<{ ok: true }>(ROUTE_WRITE_FILE, { path, content });
  }

  async editFile(path: string, edits: readonly SandboxEdit[]): Promise<SandboxEditResult> {
    const body = await this.post<EditFileResponse>(ROUTE_EDIT_FILE, { path, edits });
    return body.result;
  }

  /**
   * Open the exec WebSocket, stream frames, and assemble the result. An
   * external `options.signal` abort closes the socket (the agent reaps the
   * process tree) and resolves with `exitCode: 124`, `signaled: true`.
   */
  exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult> {
    const started = Date.now();
    const wsUrl = this.base.replace(/^http/, "ws") + ROUTE_EXEC;
    const ws = new WebSocket(wsUrl, this.wsHeaders());

    return new Promise<SandboxExecResult>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let aborted = false;

      const settle = (result: SandboxExecResult): void => {
        if (settled) return;
        settled = true;
        options?.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        options?.signal?.removeEventListener("abort", onAbort);
        reject(err);
      };

      const onAbort = (): void => {
        aborted = true;
        try {
          ws.close();
        } catch {
          // socket may already be closing
        }
        settle({
          stdout,
          stderr: stderr + "\n[sandbox: command aborted]",
          exitCode: 124,
          signaled: true,
          durationMs: Date.now() - started,
        });
      };

      if (options?.signal) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      ws.on("open", () => {
        const init: ExecInitFrame = {
          command,
          ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
          ...(options?.env !== undefined ? { env: options.env } : {}),
          ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
          ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        };
        ws.send(JSON.stringify(init));
      });

      ws.on("message", (data) => {
        let frame: ExecServerFrame;
        try {
          frame = JSON.parse(data.toString()) as ExecServerFrame;
        } catch {
          return;
        }
        if (frame.type === "output") {
          if (frame.stream === "stdout") stdout += frame.chunk;
          else stderr += frame.chunk;
          options?.onOutput?.({ stream: frame.stream, chunk: frame.chunk });
        } else if (frame.type === "exit") {
          settle({
            stdout,
            stderr,
            exitCode: frame.exitCode,
            signaled: frame.signaled,
            durationMs: frame.durationMs,
          });
        } else {
          fail(deserializeSandboxError(frame.error));
        }
      });

      ws.on("error", (err) => {
        if (aborted) return;
        fail(err instanceof Error ? err : new Error(String(err)));
      });
      ws.on("close", () => {
        // Closed without an exit frame and not via abort → surface partial output.
        if (aborted) return;
        settle({ stdout, stderr, exitCode: 1, signaled: false, durationMs: Date.now() - started });
      });
    });
  }

  // ── HTTP primitives (fetch over http/https) ────────────────────────────────

  private async get<T>(route: string): Promise<T> {
    const res = await fetch(this.base + route, { headers: this.httpHeaders() });
    return this.parse<T>(res);
  }

  private async post<T>(route: string, body: unknown): Promise<T> {
    const res = await fetch(this.base + route, {
      method: "POST",
      headers: { ...this.httpHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.parse<T>(res);
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      const parsed = safeJson<AgentErrorBody>(text);
      if (parsed?.error) throw deserializeSandboxError(parsed.error);
      throw new Error(`sandbox agent ${res.status}: ${text}`);
    }
    return JSON.parse(text) as T;
  }

  private httpHeaders(): Record<string, string> {
    if (this.token === null) return {};
    return { [HEADER_PROXY_AUTH]: this.token, [HEADER_PROXY_PORT]: String(this.port) };
  }

  private wsHeaders(): { headers?: Record<string, string> } {
    if (this.token === null) return {};
    return { headers: { [HEADER_PROXY_AUTH]: this.token, [HEADER_PROXY_PORT]: String(this.port) } };
  }
}

function safeJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
