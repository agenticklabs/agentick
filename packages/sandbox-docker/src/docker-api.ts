/**
 * Docker Engine API Client
 *
 * Thin HTTP client over Unix socket (`node:http`). Zero external dependencies.
 * Implements the subset needed for sandbox operations: containers, exec, volumes.
 *
 * Docker's exec stream uses a multiplexed protocol (8-byte header per frame):
 * byte 0 = stream type (1=stdout, 2=stderr), bytes 1-3 = padding,
 * bytes 4-7 = payload length (big-endian uint32).
 */

import http from "node:http";

const DEFAULT_SOCKET = "/var/run/docker.sock";
const API_VERSION = "v1.43";
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB per stream

// ── Types ────────────────────────────────────────────────────────────────────

export interface ContainerConfig {
  Image: string;
  Cmd?: string[];
  Env?: string[];
  WorkingDir?: string;
  Labels?: Record<string, string>;
  HostConfig?: {
    Binds?: string[];
    Memory?: number;
    NanoCpus?: number;
    PidsLimit?: number;
    NetworkMode?: string;
  };
}

export interface ExecConfig {
  Cmd: string[];
  Env?: string[];
  AttachStdout?: boolean;
  AttachStderr?: boolean;
  WorkingDir?: string;
}

export interface ExecStreamCallbacks {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  signal?: AbortSignal;
}

export interface ExecStreamResult {
  stdout: string;
  stderr: string;
}

// ── Error ────────────────────────────────────────────────────────────────────

export class DockerAPIError extends Error {
  readonly name = "DockerAPIError";
  constructor(
    readonly statusCode: number,
    message: string,
    readonly endpoint: string,
  ) {
    super(`Docker ${statusCode}: ${message} (${endpoint})`);
  }
}

// ── Client ───────────────────────────────────────────────────────────────────

export class DockerAPI {
  private readonly socketPath: string;

  constructor(socketPath: string = DEFAULT_SOCKET) {
    this.socketPath = socketPath;
  }

  async ping(): Promise<void> {
    await this.get("/_ping");
  }

  async createContainer(config: ContainerConfig): Promise<string> {
    const body = await this.post<{ Id: string }>(`/${API_VERSION}/containers/create`, config);
    return body.Id;
  }

  async startContainer(id: string): Promise<void> {
    await this.post(`/${API_VERSION}/containers/${id}/start`);
  }

  async removeContainer(id: string, opts?: { force?: boolean; v?: boolean }): Promise<void> {
    const params = new URLSearchParams();
    if (opts?.force) params.set("force", "true");
    if (opts?.v) params.set("v", "true");
    const qs = params.toString();
    await this.del(`/${API_VERSION}/containers/${id}${qs ? `?${qs}` : ""}`);
  }

  async execCreate(containerId: string, config: ExecConfig): Promise<string> {
    const body = await this.post<{ Id: string }>(
      `/${API_VERSION}/containers/${containerId}/exec`,
      config,
    );
    return body.Id;
  }

  /**
   * Start an exec instance and collect multiplexed stdout/stderr.
   *
   * On abort (via signal), resolves with whatever output was collected
   * rather than rejecting — matches sandbox-local's timeout behavior
   * of preserving partial output.
   */
  execStart(execId: string, callbacks?: ExecStreamCallbacks): Promise<ExecStreamResult> {
    const endpoint = `/${API_VERSION}/exec/${execId}/start`;

    return new Promise<ExecStreamResult>((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let pending = Buffer.alloc(0);
      let aborted = false;
      let settled = false;

      const finalize = () => {
        if (settled) return;
        settled = true;
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString(),
          stderr: Buffer.concat(stderrChunks).toString(),
        });
      };

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const processPending = () => {
        while (pending.length >= 8) {
          const payloadLen = pending.readUInt32BE(4);
          if (pending.length < 8 + payloadLen) break;

          const streamType = pending[0]!;
          const payload = pending.subarray(8, 8 + payloadLen);
          pending = pending.subarray(8 + payloadLen);

          if (streamType === 1) {
            callbacks?.onStdout?.(payload.toString());
            if (stdoutBytes < MAX_OUTPUT_BYTES) {
              stdoutChunks.push(payload);
              stdoutBytes += payload.length;
            }
          } else if (streamType === 2) {
            callbacks?.onStderr?.(payload.toString());
            if (stderrBytes < MAX_OUTPUT_BYTES) {
              stderrChunks.push(payload);
              stderrBytes += payload.length;
            }
          }
        }
      };

      const req = http.request(
        {
          socketPath: this.socketPath,
          path: endpoint,
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 400) {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
              const msg = parseErrorMessage(Buffer.concat(chunks));
              fail(new DockerAPIError(res.statusCode!, msg, endpoint));
            });
            return;
          }

          res.on("data", (chunk: Buffer) => {
            pending = Buffer.concat([pending, chunk]);
            processPending();
          });

          res.on("end", finalize);
          res.on("error", (err) => {
            if (aborted) finalize();
            else fail(err);
          });
        },
      );

      req.on("error", (err) => {
        if (aborted) finalize();
        else fail(err);
      });

      if (callbacks?.signal) {
        const handler = () => {
          aborted = true;
          req.destroy();
        };
        callbacks.signal.addEventListener("abort", handler, { once: true });
      }

      req.write(JSON.stringify({ Detach: false, Tty: false }));
      req.end();
    });
  }

  async execInspect(execId: string): Promise<{ ExitCode: number; Running: boolean }> {
    return this.get(`/${API_VERSION}/exec/${execId}/json`);
  }

  async createVolume(name?: string): Promise<{ Name: string; Mountpoint: string }> {
    return this.post(`/${API_VERSION}/volumes/create`, name ? { Name: name } : {});
  }

  async removeVolume(name: string): Promise<void> {
    await this.del(`/${API_VERSION}/volumes/${name}`);
  }

  // ── HTTP primitives ──────────────────────────────────────────────────────

  private get<T = unknown>(path: string): Promise<T> {
    return this.request("GET", path);
  }

  private post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request("POST", path, body);
  }

  private del<T = unknown>(path: string): Promise<T> {
    return this.request("DELETE", path);
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const buf = Buffer.concat(chunks);

            if (res.statusCode && res.statusCode >= 400) {
              const msg = parseErrorMessage(buf);
              reject(new DockerAPIError(res.statusCode, msg, path));
              return;
            }

            if (buf.length === 0) {
              resolve(undefined as T);
              return;
            }

            try {
              resolve(JSON.parse(buf.toString()) as T);
            } catch {
              resolve(buf.toString() as T);
            }
          });
          res.on("error", reject);
        },
      );

      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }
}

function parseErrorMessage(buf: Buffer): string {
  const text = buf.toString();
  try {
    return (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    return text;
  }
}
