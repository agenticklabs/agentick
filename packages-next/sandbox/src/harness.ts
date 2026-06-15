/**
 * `SandboxHarness` — `BaseHarness<"sandbox">` wrapping a live
 * `SandboxHandle` produced by a `SandboxProvider`.
 *
 * Every command (exec/readFile/writeFile/editFile/stat/readdir/
 * addMount/removeMount/listMounts/destroy) is a journaled operation
 * with the standard phase contract (`requested → before → terminal`).
 * `exec` additionally streams stdout/stderr as `:delta` envelopes.
 *
 * ACL: the harness checks every read/write/exec/mount against the
 * static `acl` config + per-session learned decisions. When neither
 * allows, the harness delegates to its `ElicitationHarnessProtocol`
 * — the same substrate primitive that backs tool confirmation, MCP
 * elicitation, and any other "ask user X" step. The wire envelope
 * lands on `session:channel:elicitation` with
 * `hints.kind: "sandbox_permission"`; the reply is validated against
 * `SANDBOX_PERMISSION_REPLY_SCHEMA`. Decisions matching the
 * `*-session*` variants are remembered on the session ACL.
 *
 * @see docs/proposals/v2/blueprint/24-sandbox-as-harness.md
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 */

import { Effect } from "effect";
import { BaseHarness, runHarnessProtocol } from "@agentick/runtime-next";
import type {
  ElicitationHarnessProtocol,
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  Operation,
  OperationJournal,
  SandboxACL,
  SandboxDirEntry,
  SandboxEditFileInput,
  SandboxEditResult,
  SandboxExecInput,
  SandboxExecResult,
  SandboxHandle,
  SandboxPermissionRequest,
  SandboxProvider,
  SandboxReadFileInput,
  SandboxReaddirInput,
  SandboxStat,
  SandboxStatInput,
  SandboxWriteFileInput,
} from "@agentick/spec-next";

import {
  SANDBOX_PERMISSION_KIND,
  SANDBOX_PERMISSION_REPLY_SCHEMA,
  type SandboxPermissionReply,
} from "./permission-schema.js";

import { SessionACL, type SessionACLSnapshot } from "./acl.js";
import {
  sandboxExecError,
  sandboxIoError,
  sandboxPermissionDenied,
  type SandboxConnectionError,
  type SandboxError,
  type SandboxExecError,
  type SandboxIoError,
  type SandboxPermissionDeniedError,
} from "./errors.js";

// ============================================================================
// Options
// ============================================================================

export interface SandboxHarnessOptions {
  readonly sandboxId: string;
  readonly handle: SandboxHandle;
  readonly providerName: string;
  /** Static ACL config from `<Sandbox allow={...}>`. Optional. */
  readonly acl?: SandboxACL;
  /**
   * Default decision when the permission elicitation times out and no
   * policy answered. Default: `"deny"`.
   */
  readonly permissionTimeoutDecision?: "allow-once" | "deny";
  /**
   * Permission elicitation wait bound. Default: 30s (matches the tool
   * executor's default confirmation timeout). On expiry the harness
   * falls back to `permissionTimeoutDecision`.
   */
  readonly permissionTimeoutMs?: number;
  /**
   * Elicitation harness used by the permission gate. Required: every
   * permission round-trip goes through `elicitation.elicit(...)`
   * with `hints.kind: "sandbox_permission"` instead of the harness
   * rolling its own channel.
   */
  readonly elicitation: ElicitationHarnessProtocol;
}

// ============================================================================
// Harness
// ============================================================================

export type SandboxStatus = "creating" | "ready" | "degraded" | "failed" | "destroyed";

export class SandboxHarness extends BaseHarness<"sandbox"> {
  readonly sandboxId: string;
  readonly providerName: string;
  readonly workspacePath: string;
  private readonly handle: SandboxHandle;
  private readonly acl?: SandboxACL;
  private readonly sessionACL = new SessionACL();
  private readonly permissionTimeoutDecision: "allow-once" | "deny";
  private readonly permissionTimeoutMs: number;
  private readonly elicitation: ElicitationHarnessProtocol;
  private _status: SandboxStatus = "ready";

  constructor(
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: SandboxHarnessOptions,
  ) {
    super("sandbox", options.sandboxId, journal, bus, inbox);
    this.sandboxId = options.sandboxId;
    this.providerName = options.providerName;
    this.handle = options.handle;
    this.workspacePath = options.handle.workspacePath;
    this.acl = options.acl;
    this.permissionTimeoutDecision = options.permissionTimeoutDecision ?? "deny";
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? 30_000;
    this.elicitation = options.elicitation;
  }

  /**
   * Static factory that constructs the harness from a provider +
   * options. Provider is responsible for creating the handle; the
   * harness wraps it.
   */
  static async fromProvider(
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    init: {
      readonly sandboxId: string;
      readonly provider: SandboxProvider;
      readonly options: import("@agentick/spec-next").SandboxCreateOptions;
      readonly acl?: SandboxACL;
      readonly elicitation: ElicitationHarnessProtocol;
      readonly permissionTimeoutDecision?: "allow-once" | "deny";
      readonly permissionTimeoutMs?: number;
    },
  ): Promise<SandboxHarness> {
    const handle = await init.provider.create(init.options);
    return new SandboxHarness(journal, bus, inbox, {
      sandboxId: init.sandboxId,
      handle,
      providerName: init.provider.name,
      elicitation: init.elicitation,
      ...(init.acl !== undefined ? { acl: init.acl } : {}),
      ...(init.permissionTimeoutDecision !== undefined
        ? { permissionTimeoutDecision: init.permissionTimeoutDecision }
        : {}),
      ...(init.permissionTimeoutMs !== undefined
        ? { permissionTimeoutMs: init.permissionTimeoutMs }
        : {}),
    });
  }

  get status(): SandboxStatus {
    return this._status;
  }

  // ──────────────── Public command surface ────────────────

  exec(input: SandboxExecInput): Promise<SandboxExecResult> {
    const op: Operation<SandboxExecInput, SandboxExecResult> = {
      opId: `sandbox:${this.sandboxId}:exec:${randomOpId()}`,
      surface: "sandbox",
      name: "sandbox:command:exec",
      scope: { sandboxId: this.sandboxId },
      input,
    };
    return runHarnessProtocol(this.runOperation(op, (i) => this.execBody(i)));
  }

  readFile(input: SandboxReadFileInput): Promise<string> {
    const op: Operation<SandboxReadFileInput, string> = {
      opId: `sandbox:${this.sandboxId}:read-file:${randomOpId()}`,
      surface: "sandbox",
      name: "sandbox:command:read-file",
      scope: { sandboxId: this.sandboxId },
      input,
    };
    return runHarnessProtocol(this.runOperation(op, (i) => this.readFileBody(i)));
  }

  writeFile(input: SandboxWriteFileInput): Promise<void> {
    const op: Operation<SandboxWriteFileInput, void> = {
      opId: `sandbox:${this.sandboxId}:write-file:${randomOpId()}`,
      surface: "sandbox",
      name: "sandbox:command:write-file",
      scope: { sandboxId: this.sandboxId },
      input,
    };
    return runHarnessProtocol(this.runOperation(op, (i) => this.writeFileBody(i)));
  }

  editFile(input: SandboxEditFileInput): Promise<SandboxEditResult> {
    const op: Operation<SandboxEditFileInput, SandboxEditResult> = {
      opId: `sandbox:${this.sandboxId}:edit-file:${randomOpId()}`,
      surface: "sandbox",
      name: "sandbox:command:edit-file",
      scope: { sandboxId: this.sandboxId },
      input,
    };
    return runHarnessProtocol(this.runOperation(op, (i) => this.editFileBody(i)));
  }

  stat(input: SandboxStatInput): Promise<SandboxStat> {
    const op: Operation<SandboxStatInput, SandboxStat> = {
      opId: `sandbox:${this.sandboxId}:stat:${randomOpId()}`,
      surface: "sandbox",
      name: "sandbox:command:stat",
      scope: { sandboxId: this.sandboxId },
      input,
    };
    return runHarnessProtocol(this.runOperation(op, (i) => this.statBody(i)));
  }

  readdir(input: SandboxReaddirInput): Promise<readonly SandboxDirEntry[]> {
    const op: Operation<SandboxReaddirInput, readonly SandboxDirEntry[]> = {
      opId: `sandbox:${this.sandboxId}:readdir:${randomOpId()}`,
      surface: "sandbox",
      name: "sandbox:command:readdir",
      scope: { sandboxId: this.sandboxId },
      input,
    };
    return runHarnessProtocol(this.runOperation(op, (i) => this.readdirBody(i)));
  }

  destroy(): Promise<void> {
    const op: Operation<undefined, void> = {
      opId: `sandbox:${this.sandboxId}:destroy:${randomOpId()}`,
      surface: "sandbox",
      name: "sandbox:command:destroy",
      scope: { sandboxId: this.sandboxId },
      input: undefined,
    };
    return runHarnessProtocol(this.runOperation(op, () => this.destroyBody()));
  }

  // ──────────────── Command bodies ────────────────

  private execBody(input: SandboxExecInput): Effect.Effect<SandboxExecResult, SandboxError, never> {
    return Effect.gen(this, function* () {
      const allowed = yield* this.checkPermission("exec", input.command);
      if (!allowed) {
        return yield* Effect.fail(sandboxPermissionDenied("exec", input.command, "user-denied"));
      }
      return yield* Effect.tryPromise<SandboxExecResult, SandboxExecError>({
        try: () =>
          this.handle.exec(input.command, {
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.env !== undefined ? { env: input.env } : {}),
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
            ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
          }),
        catch: (cause): SandboxExecError => sandboxExecError(input.command, -1, { cause }),
      });
    });
  }

  private readFileBody(input: SandboxReadFileInput): Effect.Effect<string, SandboxError, never> {
    return Effect.gen(this, function* () {
      const allowed = yield* this.checkPermission("read", input.path);
      if (!allowed) {
        return yield* Effect.fail(sandboxPermissionDenied("read", input.path, "user-denied"));
      }
      return yield* Effect.tryPromise<string, SandboxIoError>({
        try: () => this.handle.readFile(input.path),
        catch: (cause): SandboxIoError =>
          sandboxIoError(input.path, "read", "provider failed", cause),
      });
    });
  }

  private writeFileBody(input: SandboxWriteFileInput): Effect.Effect<void, SandboxError, never> {
    return Effect.gen(this, function* () {
      const allowed = yield* this.checkPermission("write", input.path);
      if (!allowed) {
        return yield* Effect.fail(sandboxPermissionDenied("write", input.path, "user-denied"));
      }
      return yield* Effect.tryPromise<void, SandboxIoError>({
        try: () => this.handle.writeFile(input.path, input.content),
        catch: (cause): SandboxIoError =>
          sandboxIoError(input.path, "write", "provider failed", cause),
      });
    });
  }

  private editFileBody(
    input: SandboxEditFileInput,
  ): Effect.Effect<SandboxEditResult, SandboxError, never> {
    // Defer to v1's `applyEdits` after permission check. Adopters who
    // need richer edit semantics extend by composing read+write.
    return Effect.gen(this, function* () {
      const allowed = yield* this.checkPermission("write", input.path);
      if (!allowed) {
        return yield* Effect.fail(sandboxPermissionDenied("write", input.path, "user-denied"));
      }
      // Read current → apply pure transform → write atomically.
      const current = yield* Effect.tryPromise<string, SandboxIoError>({
        try: () => this.handle.readFile(input.path),
        catch: (cause): SandboxIoError => sandboxIoError(input.path, "edit", "read failed", cause),
      });
      const applied = applyEditsLocal(current, input.edits);
      yield* Effect.tryPromise<void, SandboxIoError>({
        try: () => this.handle.writeFile(input.path, applied.content),
        catch: (cause): SandboxIoError => sandboxIoError(input.path, "edit", "write failed", cause),
      });
      return {
        applied: applied.applied,
        skipped: applied.skipped,
        content: applied.content,
        hash: hashOf(applied.content),
      } satisfies SandboxEditResult;
    });
  }

  private statBody(input: SandboxStatInput): Effect.Effect<SandboxStat, SandboxError, never> {
    // stat piggybacks on read permission (see ADR 24 OQ24.8).
    return Effect.gen(this, function* () {
      const allowed = yield* this.checkPermission("read", input.path);
      if (!allowed) {
        return yield* Effect.fail(sandboxPermissionDenied("read", input.path, "user-denied"));
      }
      // The provider's `SandboxHandle` doesn't expose stat directly in
      // the v2 spec; adopters override at the harness subclass level
      // until the provider surface grows. For now, attempt readFile
      // and infer existence — a minimal stat for the MVP.
      return yield* Effect.tryPromise<SandboxStat, SandboxIoError>({
        try: async () => {
          const text = await this.handle.readFile(input.path);
          return {
            path: input.path,
            size: text.length,
            kind: "file" as const,
            mtime: Date.now(),
          };
        },
        catch: (cause): SandboxIoError => sandboxIoError(input.path, "stat", "stat failed", cause),
      });
    });
  }

  private readdirBody(
    input: SandboxReaddirInput,
  ): Effect.Effect<readonly SandboxDirEntry[], SandboxError, never> {
    return Effect.gen(this, function* () {
      const allowed = yield* this.checkPermission("read", input.path);
      if (!allowed) {
        return yield* Effect.fail(sandboxPermissionDenied("read", input.path, "user-denied"));
      }
      // Best-effort: use shell to list. Replace with provider-native
      // readdir once SandboxHandle exposes it.
      return yield* Effect.tryPromise<readonly SandboxDirEntry[], SandboxIoError>({
        try: async () => {
          const result = await this.handle.exec(`ls -1A '${input.path.replace(/'/g, "'\\''")}'`);
          if (result.exitCode !== 0) {
            throw new Error(result.stderr || "ls failed");
          }
          return result.stdout
            .split("\n")
            .filter((s) => s.length > 0)
            .map((name): SandboxDirEntry => ({ name, kind: "file" }));
        },
        catch: (cause): SandboxIoError =>
          sandboxIoError(input.path, "readdir", "readdir failed", cause),
      });
    });
  }

  private destroyBody(): Effect.Effect<void, SandboxError, never> {
    return Effect.gen(this, function* () {
      yield* Effect.tryPromise<void, SandboxConnectionError>({
        try: () => this.handle.destroy(),
        catch: (cause): SandboxConnectionError => ({
          _tag: "SandboxConnectionError",
          reason: "destroy failed",
          cause,
        }),
      });
      this._status = "destroyed";
    });
  }

  // ──────────────── Permission flow ────────────────

  /**
   * Check whether an operation is permitted. Returns `true` on allow,
   * `false` on deny. May `Effect.fail` if the request itself fails
   * (the harness's request/response primitive rejects).
   *
   * The flow:
   *   1. Evaluate against static config + session-learned state.
   *   2. If "allow" or "deny", return immediately.
   *   3. If "pending", issue `this.request("sandbox_permission", ...)`.
   *   4. Apply the response — remember `*-session*` decisions on the
   *      session ACL.
   *   5. Return the resulting allow/deny boolean.
   */
  private checkPermission(
    kind: "read" | "write" | "exec",
    target: string,
  ): Effect.Effect<boolean, SandboxPermissionDeniedError, never> {
    return Effect.gen(this, function* () {
      const verdict = this.sessionACL.evaluate(this.acl, kind, target);
      if (verdict === "allow") return true;
      if (verdict === "deny") return false;

      // Pending — delegate to the elicitation harness. The wire
      // envelope's `metadata` carries the structured permission
      // request shape (kind/path/command/sandboxId/rationale) so
      // clients can render a richly-typed prompt; the `hints.kind`
      // routes to the sandbox-permission renderer.
      const telemetry: SandboxPermissionRequest =
        kind === "exec"
          ? {
              kind: "exec",
              command: target,
              sandboxId: this.sandboxId,
              rationale: "not in static or session-learned allow list",
            }
          : {
              kind,
              path: target,
              sandboxId: this.sandboxId,
              rationale: "not in static or session-learned allow list",
            };
      const message =
        kind === "exec"
          ? `Allow sandbox to execute: ${target}`
          : `Allow sandbox to ${kind} ${target}?`;

      const elicitResult = yield* Effect.promise(() =>
        this.elicitation.elicit(
          {
            message,
            schema: SANDBOX_PERMISSION_REPLY_SCHEMA,
            hints: { kind: SANDBOX_PERMISSION_KIND },
            metadata: telemetry,
          },
          { timeoutMs: this.permissionTimeoutMs },
        ),
      );

      const reply = sandboxReplyFromElicitResult(elicitResult, this.permissionTimeoutDecision);
      return this.applyDecision(kind, target, reply);
    });
  }

  private applyDecision(
    kind: "read" | "write" | "exec",
    target: string,
    reply: SandboxPermissionReply,
  ): boolean {
    switch (reply.decision) {
      case "allow-once":
        return true;
      case "allow-session":
        this.sessionACL.rememberAllow(kind, target);
        return true;
      case "allow-session-pattern":
        if (typeof reply.pattern === "string") {
          this.sessionACL.rememberAllow(kind, reply.pattern);
        } else {
          // Schema requires `pattern` here, but if a client sends a
          // malformed reply that bypassed validation, fall back to
          // the narrower target-only allow.
          this.sessionACL.rememberAllow(kind, target);
        }
        return true;
      case "deny":
        return false;
      case "deny-session":
        this.sessionACL.rememberDeny(kind, target);
        return false;
    }
  }

  // ──────────────── Session ACL snapshot ────────────────

  exportACLSnapshot(): SessionACLSnapshot {
    return this.sessionACL.exportSnapshot();
  }

  importACLSnapshot(snap: SessionACLSnapshot): void {
    this.sessionACL.importSnapshot(snap);
  }

  // ──────────────── Inbox ────────────────

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    // Inbox dispatch (abort-exec, destroy, status-probe) is a future
    // refinement; for now the harness only responds to direct method
    // calls. Reject unknown messages explicitly.
    return Effect.fail({
      _tag: "HandlerError",
      cause: new Error("sandbox harness inbox dispatch not yet wired"),
    });
  }
}

// ============================================================================
// Helpers
// ============================================================================

function randomOpId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function hashOf(content: string): string {
  // Cheap, deterministic content hash. Not cryptographic — adopters
  // who need crypto-grade hashing override `editFile` at the
  // application level or wrap the harness in middleware.
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * Minimal in-process edit applier — supports `replace`, `delete`,
 * `insert-before`, `insert-after`. Mirrors a subset of v1's
 * `applyEdits`; adopters using rich edit modes (range, indentation
 * recovery, CRLF tolerance) should compose with v1's full
 * `applyEdits` via a custom `editFile` middleware wrapper.
 */
function applyEditsLocal(
  current: string,
  edits: readonly import("@agentick/spec-next").SandboxEdit[],
): { applied: number; skipped: number; content: string } {
  let content = current;
  let applied = 0;
  let skipped = 0;
  for (const edit of edits) {
    const mode = edit.mode ?? (edit.new !== undefined ? "replace" : "delete");
    if (!edit.old) {
      skipped += 1;
      continue;
    }
    const target = edit.old;
    if (!content.includes(target)) {
      skipped += 1;
      continue;
    }
    if (mode === "replace") {
      content = edit.all
        ? content.split(target).join(edit.new ?? "")
        : content.replace(target, edit.new ?? "");
    } else if (mode === "delete") {
      content = edit.all ? content.split(target).join("") : content.replace(target, "");
    } else if (mode === "insert-before") {
      content = content.replace(target, `${edit.new ?? ""}${target}`);
    } else if (mode === "insert-after") {
      content = content.replace(target, `${target}${edit.new ?? ""}`);
    } else {
      skipped += 1;
      continue;
    }
    applied += 1;
  }
  return { applied, skipped, content };
}

/**
 * Translate an elicitation result back into a sandbox permission
 * reply. Accepted+valid → the validated reply. Every other outcome
 * (declined, cancelled, failed.timeout, failed.aborted,
 * failed.schema_violation) → the configured fallback decision.
 */
function sandboxReplyFromElicitResult(
  result: import("@agentick/spec-next").ElicitationResult<SandboxPermissionReply>,
  fallback: "allow-once" | "deny",
): SandboxPermissionReply {
  if (result.outcome === "accepted") return result.value;
  return { decision: fallback };
}
