/**
 * Sandbox Contract Types
 *
 * All types for the sandbox abstraction layer.
 * Provider adapters (@agentick/sandbox-local, @agentick/sandbox-docker, etc.)
 * implement SandboxProvider.
 */

import type { Edit, EditResult } from "./edit.js";

// ── Core Runtime Handle ─────────────────────────────────────────────────────

export interface Sandbox {
  /** Unique sandbox instance ID. */
  readonly id: string;

  /** Absolute path to the workspace root inside the sandbox. */
  readonly workspacePath: string;

  /** Execute a shell command. */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  /** Read a file from the sandbox filesystem. */
  readFile(path: string): Promise<string>;

  /** Write a file to the sandbox filesystem. */
  writeFile(path: string, content: string): Promise<void>;

  /** Apply surgical edits to a file. */
  editFile(path: string, edits: Edit[]): Promise<EditResult>;

  /** Add a filesystem mount at runtime. Takes effect immediately. */
  addMount(mount: Mount): Promise<void>;

  /** Remove a mount by host path. */
  removeMount(hostPath: string): void;

  /** List current mounts. */
  listMounts(): Mount[];

  /** Tear down the sandbox and release resources. */
  destroy(): Promise<void>;
}

// ── Provider ────────────────────────────────────────────────────────────────

export interface SandboxProvider {
  /** Provider name (e.g. "local", "docker", "e2b"). */
  readonly name: string;

  /** Create a new sandbox instance. */
  create(options: SandboxCreateOptions): Promise<Sandbox>;

  /** Restore a sandbox from a snapshot. */
  restore?(snapshot: SandboxSnapshot): Promise<Sandbox>;

  /** Destroy a sandbox (provider-level cleanup). */
  destroy?(sandbox: Sandbox): Promise<void>;
}

// ── Options & Config ────────────────────────────────────────────────────────

export interface SandboxCreateOptions {
  /** Session ID for associating the sandbox with a session. */
  sessionId?: string;

  /** Workspace directory path, or true to auto-create a temp directory. */
  workspace?: string | true;

  /** Host↔sandbox path mappings. */
  mounts?: Mount[];

  /** Advisory permissions. */
  permissions?: Permissions;

  /** Environment variables. */
  env?: Record<string, string>;

  /** Resource constraints. */
  limits?: ResourceLimits;
}

export interface SandboxConfig {
  provider: SandboxProvider;
  workspace?: string | true;
  mounts?: Mount[];
  permissions?: Permissions;
  env?: Record<string, string | (() => string)>;
  limits?: ResourceLimits;
  setup?: (sandbox: Sandbox) => Promise<void>;
  persist?: boolean;
}

// ── Snapshot ────────────────────────────────────────────────────────────────

export interface SandboxSnapshot {
  /** Provider name that created this sandbox. */
  provider: string;

  /** Sandbox ID. */
  id: string;

  /** Workspace path. */
  workspacePath: string;

  /** Provider-specific state for restoration. */
  state?: Record<string, unknown>;
}

// ── Execution ───────────────────────────────────────────────────────────────

export interface ExecOptions {
  /** Working directory for the command. */
  cwd?: string;

  /** Additional environment variables. */
  env?: Record<string, string>;

  /** Timeout in milliseconds. */
  timeout?: number;

  /** Streaming output callback. Called for each chunk of stdout/stderr. */
  onOutput?: (chunk: OutputChunk) => void;
}

export interface ExecResult {
  /** Standard output. */
  stdout: string;

  /** Standard error. */
  stderr: string;

  /** Process exit code. */
  exitCode: number;
}

export interface OutputChunk {
  /** Which output stream this chunk came from. */
  stream: "stdout" | "stderr";

  /** The data content. */
  data: string;
}

// ── Mounts ──────────────────────────────────────────────────────────────────

export interface Mount {
  /** Host filesystem path. */
  host: string;

  /** Sandbox filesystem path. */
  sandbox: string;

  /** Mount mode. Default: "rw". */
  mode?: "ro" | "rw";
}

// ── Permissions ─────────────────────────────────────────────────────────────

export interface Permissions {
  /** Filesystem access. Default: true. */
  fs?: boolean;

  /**
   * Network access. Default: false.
   * - `false` — deny all (default)
   * - `true` — allow all
   * - `NetworkRule[]` — apply rules in order, first match wins, default deny
   */
  net?: boolean | NetworkRule[];

  /** Child process spawning. Default: true. */
  childProcess?: boolean;

  /** Inherit host environment variables. Default: false. */
  inheritEnv?: boolean;
}

// ── Resource Limits ─────────────────────────────────────────────────────────

export interface ResourceLimits {
  /** Memory limit in bytes. */
  memory?: number;

  /** CPU limit (fractional cores, e.g. 0.5). */
  cpu?: number;

  /** Global timeout in milliseconds. */
  timeout?: number;

  /** Disk limit in bytes. */
  disk?: number;

  /** Maximum concurrent processes. */
  maxProcesses?: number;
}

// ── Network Rules ──────────────────────────────────────────────────────────

export interface NetworkRule {
  /** "allow" or "deny". Rules evaluated in order; first match wins. */
  action: "allow" | "deny";

  /** Domain pattern. Supports wildcards: "*.example.com", "api.github.com". */
  domain?: string;

  /** URL regex pattern. Matched against full URL. */
  urlPattern?: string;

  /** HTTP methods to match. Default: all. */
  methods?: string[];

  /** Port to match. */
  port?: number;
}

export interface ProxiedRequest {
  /** Full URL of the request. */
  url: string;

  /** HTTP method. */
  method: string;

  /** Target host. */
  host: string;

  /** Target port. */
  port: number;

  /** Unix timestamp (ms) when the request was made. */
  timestamp: number;

  /** Whether the request was blocked. */
  blocked: boolean;

  /** The rule that matched, if any. */
  matchedRule?: NetworkRule;
}
