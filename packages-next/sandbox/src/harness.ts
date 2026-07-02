/**
 * `SandboxHarness` — `BaseHarness<"sandbox">` wrapping a live
 * `SandboxHandle` produced by a `SandboxProvider`.
 *
 * All seven verbs (exec/read-file/write-file/edit-file/stat/readdir/
 * destroy) are declared commands (ADR 51, `this.command()` in the
 * constructor): each runs through `runOperation` with canonical
 * naming (`sandbox:command:<rest>`) and the standard phase contract
 * (`requested → before → terminal`), and the same verbs are
 * inbox-addressable over `sandbox:{sandboxId}` (`"sandbox:exec"`,
 * `"sandbox:read-file"`, …) with zero routing code. All sandbox
 * inputs are pure data, so no operation stays hand-built under the
 * ADR 51 §1.2 signal-form doctrine.
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
 * @see docs/proposals/v2/blueprint/51-invocation-and-authorization.md
 */

import { omitUndefined } from "@agentick/utils-next";

import { Effect } from "effect";
import { BaseHarness } from "@agentick/runtime-next";
import type {
  ElicitationHarnessProtocol,
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
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
import { HandlerError } from "@agentick/spec-next";

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
  SandboxConnectionError,
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

/** Public shape of a declared command (ADR 51) as stored on the harness. */
type Cmd<I, R> = (input: I) => Promise<R>;

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

  // ─── Declared commands (ADR 51) — assigned in the constructor ───
  private readonly execCmd: Cmd<SandboxExecInput, SandboxExecResult>;
  private readonly readFileCmd: Cmd<SandboxReadFileInput, string>;
  private readonly writeFileCmd: Cmd<SandboxWriteFileInput, void>;
  private readonly editFileCmd: Cmd<SandboxEditFileInput, SandboxEditResult>;
  private readonly statCmd: Cmd<SandboxStatInput, SandboxStat>;
  private readonly readdirCmd: Cmd<SandboxReaddirInput, readonly SandboxDirEntry[]>;
  private readonly destroyCmd: Cmd<undefined, void>;

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

    // ─── Declared commands (ADR 51) — the single declaration site per
    // verb. Inbox message types, canonical op naming
    // (`sandbox:command:<rest>`), and enumeration all derive from
    // these. Payloads carried no validation before the registry;
    // schemas stay off for parity. The ACL permission gate is LAYER
    // LOGIC and lives in the command bodies, not the registry.
    const scope = () => ({ sandboxId: this.sandboxId });
    this.execCmd = this.command({
      name: "sandbox:exec",
      scope,
      handler: (i: SandboxExecInput) => this.execBody(i),
    });
    this.readFileCmd = this.command({
      name: "sandbox:read-file",
      scope,
      handler: (i: SandboxReadFileInput) => this.readFileBody(i),
    });
    this.writeFileCmd = this.command({
      name: "sandbox:write-file",
      scope,
      handler: (i: SandboxWriteFileInput) => this.writeFileBody(i),
    });
    this.editFileCmd = this.command({
      name: "sandbox:edit-file",
      scope,
      handler: (i: SandboxEditFileInput) => this.editFileBody(i),
    });
    this.statCmd = this.command({
      name: "sandbox:stat",
      scope,
      handler: (i: SandboxStatInput) => this.statBody(i),
    });
    this.readdirCmd = this.command({
      name: "sandbox:readdir",
      scope,
      handler: (i: SandboxReaddirInput) => this.readdirBody(i),
    });
    this.destroyCmd = this.command({
      name: "sandbox:destroy",
      scope,
      handler: () => this.destroyBody(),
    });
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
      ...omitUndefined({
        acl: init.acl,
        permissionTimeoutDecision: init.permissionTimeoutDecision,
        permissionTimeoutMs: init.permissionTimeoutMs,
      }),
    });
  }

  get status(): SandboxStatus {
    return this._status;
  }

  // ──────────────── Public command surface ────────────────
  // Thin wrappers over the declared commands — signatures FROZEN.

  exec(input: SandboxExecInput): Promise<SandboxExecResult> {
    return this.execCmd(input);
  }

  readFile(input: SandboxReadFileInput): Promise<string> {
    return this.readFileCmd(input);
  }

  writeFile(input: SandboxWriteFileInput): Promise<void> {
    return this.writeFileCmd(input);
  }

  editFile(input: SandboxEditFileInput): Promise<SandboxEditResult> {
    return this.editFileCmd(input);
  }

  stat(input: SandboxStatInput): Promise<SandboxStat> {
    return this.statCmd(input);
  }

  readdir(input: SandboxReaddirInput): Promise<readonly SandboxDirEntry[]> {
    return this.readdirCmd(input);
  }

  destroy(): Promise<void> {
    return this.destroyCmd(undefined);
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
            ...omitUndefined({
              cwd: input.cwd,
              env: input.env,
              timeoutMs: input.timeoutMs,
              stdin: input.stdin,
            }),
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
        catch: (cause): SandboxConnectionError =>
          new SandboxConnectionError({ reason: "destroy failed", cause }),
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

  /**
   * All seven sandbox verbs are declared commands — routed by the
   * BaseHarness command registry before this fallthrough. Only unknown
   * types land here.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: `Unknown sandbox message type: ${msg.type}` }));
  }
}

// ============================================================================
// Helpers
// ============================================================================

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
