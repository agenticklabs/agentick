/**
 * The sandbox-agent wire protocol — the contract between the far-side
 * {@link import("./agent/server.js").startSandboxAgent} (in the microVM) and
 * the near-side {@link import("./endpoint-client.js").EndpointClient} (in the
 * provider) (ADR 60).
 *
 * The mechanism: the {@link SandboxHandle} contract ops are projected onto a
 * tiny HTTP+WebSocket surface served by the in-VM agent. Reads/writes/edits
 * are request/response JSON over HTTP; `exec` is a WebSocket stream (native
 * WS support is a first-class Lambda MicroVMs endpoint protocol) carrying
 * output frames then a terminal exit frame — mapping cleanly onto the
 * `SandboxExecResult` + `onOutput` seam without an exec ceiling.
 *
 * Capability-tier note: this module is pure wire shapes + a typed-error codec
 * — no OS, no AWS. It is shared by BOTH bundles (agent + provider) so the
 * frame encoding has exactly one definition. The agent trusts inbound
 * requests (the Lambda endpoint authenticates at the edge via the JWE
 * `X-aws-proxy-auth` header; loopback is reachable only on localhost) — it
 * does NOT validate the token itself.
 *
 * @see docs/proposals/v2/blueprint/60-remote-microvm-sandbox.md
 */

import type { NetworkRule, SandboxEdit, SandboxEditResult } from "@agentick/sandbox";
import {
  SandboxEscapeError,
  SandboxExecError,
  SandboxIoError,
  SandboxPermissionDeniedError,
  SandboxUnsupportedError,
} from "@agentick/sandbox";

// ── Endpoint conventions ─────────────────────────────────────────────────────

/** Default in-VM agent port — the Lambda MicroVMs default route target. */
export const AGENT_DEFAULT_PORT = 8080;

/** HTTP routes served by the agent (request/response ops). */
export const ROUTE_INFO = "/info";
export const ROUTE_READ_FILE = "/readFile";
export const ROUTE_WRITE_FILE = "/writeFile";
export const ROUTE_EDIT_FILE = "/editFile";
/** WebSocket upgrade path for the streaming `exec` op. */
export const ROUTE_EXEC = "/exec";

/**
 * JWE bearer header the Lambda endpoint authenticates at the edge, minted by
 * `create-microvm-auth-token`. Stripped before the agent sees the request.
 */
export const HEADER_PROXY_AUTH = "x-aws-proxy-auth";
/** Selects the in-VM target port behind the endpoint (default 8080). */
export const HEADER_PROXY_PORT = "x-aws-proxy-port";
/** The key inside the SDK's `authToken` map that carries the header value. */
export const AUTH_TOKEN_MAP_KEY = "X-aws-proxy-auth";

// ── Per-session run-hook payload ─────────────────────────────────────────────
//
// `run-microvm` has no per-invocation env field; per-session config is
// delivered as the `runHookPayload` (the request body of the `/run` lifecycle
// hook). The provider serializes this shape; the image's run-hook (or, in
// loopback tests, the stub control plane) hands it to `startSandboxAgent`.

export interface RunHookPayload {
  /** Domain-level egress rules → the in-VM proxy. */
  readonly networkRules?: readonly NetworkRule[];
  /** Create-time base env applied to every exec. */
  readonly baseEnv?: Readonly<Record<string, string>>;
}

export function encodeRunHookPayload(payload: RunHookPayload): string {
  return JSON.stringify(payload);
}

export function decodeRunHookPayload(raw: string | undefined): RunHookPayload {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as RunHookPayload;
  } catch {
    return {};
  }
}

// ── HTTP request/response payloads ───────────────────────────────────────────

export interface InfoResponse {
  /** Absolute workspace root inside the microVM (the agent's cwd base). */
  readonly workspacePath: string;
}

export interface ReadFileRequest {
  readonly path: string;
}
export interface ReadFileResponse {
  readonly content: string;
}

export interface WriteFileRequest {
  readonly path: string;
  readonly content: string;
}
export interface WriteFileResponse {
  readonly ok: true;
}

export interface EditFileRequest {
  readonly path: string;
  readonly edits: readonly SandboxEdit[];
}
export interface EditFileResponse {
  readonly result: SandboxEditResult;
}

/** Error envelope for any HTTP route (status ≥ 400). */
export interface AgentErrorBody {
  readonly error: SerializedSandboxError;
}

// ── exec WebSocket frames ────────────────────────────────────────────────────

/**
 * Opening frame the client sends after the socket opens. `signal`/abort is
 * conveyed by CLOSING the socket, not a field — the agent reaps the process
 * tree on close (mirrors docker/local abort semantics; exec then reports
 * `exitCode: 124`, `signaled: true`).
 */
export interface ExecInitFrame {
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
}

/** Frames the agent streams back over the exec socket. */
export type ExecServerFrame =
  | { readonly type: "output"; readonly stream: "stdout" | "stderr"; readonly chunk: string }
  | {
      readonly type: "exit";
      readonly exitCode: number;
      readonly signaled: boolean;
      readonly durationMs: number;
    }
  | { readonly type: "error"; readonly error: SerializedSandboxError };

// ── Typed-error codec ────────────────────────────────────────────────────────
//
// The agent throws the SAME typed sandbox errors the contract mandates; this
// codec serializes them across the wire and reconstructs the concrete class on
// the near side so callers keep `instanceof SandboxIoError` etc. Errors over
// nulls, faithfully — even across a network hop.

/** Discriminated by `_tag`; carries the concrete error's scalar fields. */
export interface SerializedSandboxError {
  readonly tag: string;
  readonly message: string;
  readonly [field: string]: unknown;
}

/** Serialize a (typically sandbox) error into a wire envelope. */
export function serializeSandboxError(err: unknown): SerializedSandboxError {
  if (err instanceof SandboxIoError) {
    return { tag: err._tag, message: err.message, path: err.path, op: err.op, reason: err.reason };
  }
  if (err instanceof SandboxEscapeError) {
    return {
      tag: err._tag,
      message: err.message,
      kind: err.kind,
      target: err.target,
      ...(err.detail !== undefined ? { detail: err.detail } : {}),
    };
  }
  if (err instanceof SandboxPermissionDeniedError) {
    return {
      tag: err._tag,
      message: err.message,
      kind: err.kind,
      target: err.target,
      ...(typeof err.cause === "string" ? { deniedCause: err.cause } : {}),
    };
  }
  if (err instanceof SandboxUnsupportedError) {
    return { tag: err._tag, message: err.message, capability: err.capability };
  }
  if (err instanceof SandboxExecError) {
    return {
      tag: err._tag,
      message: err.message,
      command: err.command,
      exitCode: err.exitCode,
      ...(err.signal !== undefined ? { signal: err.signal } : {}),
      ...(err.stderr !== undefined ? { stderr: err.stderr } : {}),
    };
  }
  // Unknown / non-sandbox error — carry the message so the near side can
  // surface a faithful (if untyped) failure rather than a silent null.
  const message = err instanceof Error ? err.message : String(err);
  return { tag: "SandboxIoError", message, path: "?", op: "read", reason: message };
}

/** Reconstruct the concrete error class from a wire envelope. */
export function deserializeSandboxError(payload: SerializedSandboxError): Error {
  switch (payload.tag) {
    case "SandboxIoError":
      return new SandboxIoError({
        path: String(payload.path ?? "?"),
        op: (payload.op as SandboxIoError["op"]) ?? "read",
        reason: String(payload.reason ?? payload.message),
      });
    case "SandboxEscapeError":
      return new SandboxEscapeError({
        kind: String(payload.kind ?? "path-traversal"),
        target: String(payload.target ?? "?"),
        ...(payload.detail !== undefined ? { detail: String(payload.detail) } : {}),
      });
    case "SandboxPermissionDeniedError":
      return new SandboxPermissionDeniedError({
        kind: (payload.kind as SandboxPermissionDeniedError["kind"]) ?? "read",
        target: String(payload.target ?? "?"),
        ...(payload.deniedCause !== undefined ? { cause: String(payload.deniedCause) } : {}),
      });
    case "SandboxUnsupportedError":
      return new SandboxUnsupportedError({ capability: String(payload.capability ?? "?") });
    case "SandboxExecError":
      return new SandboxExecError({
        command: String(payload.command ?? "?"),
        exitCode: Number(payload.exitCode ?? 1),
        ...(payload.signal !== undefined ? { signal: String(payload.signal) } : {}),
        ...(payload.stderr !== undefined ? { stderr: String(payload.stderr) } : {}),
      });
    default:
      return new SandboxIoError({ path: "?", op: "read", reason: payload.message });
  }
}
