/**
 * `SandboxHarness` — `BaseHarness<"sandbox">` wrapping a live
 * `SandboxHandle` produced by a `SandboxProvider`.
 *
 * All eight verbs (exec/read-file/write-file/edit-file/add-mount/
 * remove-mount/list-mounts/destroy) are declared commands (ADR 51,
 * `this.command()` in the constructor): each runs through
 * `runOperation` with canonical naming (`sandbox:command:<rest>`) and
 * the standard phase contract (`requested → before → terminal`), and
 * the same verbs are inbox-addressable over `sandbox:{sandboxId}`
 * (`"sandbox:exec"`, `"sandbox:read-file"`, …) with zero routing code.
 * All sandbox inputs are pure data, so no operation stays hand-built
 * under the ADR 51 §1.2 signal-form doctrine.
 *
 * There is deliberately no `stat` / `readdir` verb: `bash` (`exec`)
 * subsumes listing + metadata. The v1 fakes (fabricated `stat` mtime,
 * `ls`-parsed `readdir` labelling every entry a file) are DELETED, not
 * rebuilt — a lying primitive is worse than an absent one (ADR 59).
 * `exec` streams live output: the provider's `onOutput` callback is
 * bridged to the `sandbox:command:exec` `delta` phase (#219).
 *
 * MOUNTS, by contrast, ARE real verbs (ADR 59, superseding the
 * create-time-only draft): mounting a host directory is a host-side
 * privileged op the sandboxed process can't reach through `bash`. They
 * are capability-tiered on the handle (a provider that can't remount a
 * running instance throws `SandboxUnsupportedError`) and gated by the
 * construction-time `mountAllow` ceiling. They are NOT model-facing
 * tools — mounting is a privilege boundary the model must not cross.
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
import { BaseHarness, getContext } from "@agentick/runtime-next";
import type {
  ElicitationHarnessProtocol,
  EventBus,
  EventScope,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  SandboxMount,
  Operation,
  OperationJournal,
  SandboxACL,
  SandboxAddMountInput,
  SandboxEditFileInput,
  SandboxEditResult,
  SandboxExecDelta,
  SandboxExecInput,
  SandboxExecResult,
  SandboxPermissionRequest,
  SandboxReadFileInput,
  SandboxRemoveMountInput,
  SandboxWriteFileInput,
} from "@agentick/spec-next";
import type { SandboxCreateOptions, SandboxHandle, SandboxProvider } from "./contract.js";
import { HandlerError } from "@agentick/spec-next";

import {
  SANDBOX_PERMISSION_KIND,
  SANDBOX_PERMISSION_REPLY_SCHEMA,
  type SandboxPermissionReply,
} from "./permission-schema.js";

import { matches, SessionACL, type SessionACLSnapshot } from "./acl.js";
import {
  sandboxExecError,
  sandboxIoError,
  sandboxPermissionDenied,
  SandboxConnectionError,
  type SandboxError,
  type SandboxExecError,
  type SandboxIoError,
  SandboxMountError,
  type SandboxPermissionDeniedError,
  SandboxUnsupportedError,
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
   * Runtime-mount allow-list ceiling (host-path patterns). The
   * `add-mount` command rejects any host path outside it; `undefined`
   * denies runtime mounting entirely. Sourced from
   * {@link SandboxCreateOptions.mountAllow}.
   */
  readonly mountAllow?: readonly string[];
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
  private readonly mountAllow?: readonly string[];
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
  private readonly addMountCmd: Cmd<SandboxAddMountInput, void>;
  private readonly removeMountCmd: Cmd<SandboxRemoveMountInput, void>;
  private readonly listMountCmd: Cmd<undefined, readonly SandboxMount[]>;
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
    this.mountAllow = options.mountAllow;
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
    // Mounts are dynamic harness commands, NOT model-facing tools —
    // mounting a host dir is a privilege boundary the model must not
    // cross (ADR 59, superseding "mounts = create-time only"). Gated by
    // the `mountAllow` ceiling; capability-tiered on the handle.
    this.addMountCmd = this.command({
      name: "sandbox:add-mount",
      scope,
      handler: (i: SandboxAddMountInput) => this.addMountBody(i),
    });
    this.removeMountCmd = this.command({
      name: "sandbox:remove-mount",
      scope,
      handler: (i: SandboxRemoveMountInput) => this.removeMountBody(i),
    });
    this.listMountCmd = this.command({
      name: "sandbox:list-mounts",
      scope,
      handler: () => this.listMountBody(),
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
      readonly options: SandboxCreateOptions;
      readonly acl?: SandboxACL;
      readonly elicitation: ElicitationHarnessProtocol;
      readonly permissionTimeoutDecision?: "allow-once" | "deny";
      readonly permissionTimeoutMs?: number;
    },
  ): Promise<SandboxHarness> {
    const handle = await init.provider.create(init.options);
    // #225 — post-create bootstrap. Run by the bridge/factory (not the
    // provider) so it works uniformly across every provider, and before
    // the harness is handed back / marked ready.
    await init.options.setup?.(handle);
    return new SandboxHarness(journal, bus, inbox, {
      sandboxId: init.sandboxId,
      handle,
      providerName: init.provider.name,
      elicitation: init.elicitation,
      ...omitUndefined({
        acl: init.acl,
        // The runtime-mount ceiling is a construction-time authorization,
        // sourced from the create options.
        mountAllow: init.options.mountAllow,
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

  addMount(input: SandboxAddMountInput): Promise<void> {
    return this.addMountCmd(input);
  }

  removeMount(input: SandboxRemoveMountInput): Promise<void> {
    return this.removeMountCmd(input);
  }

  listMounts(): Promise<readonly SandboxMount[]> {
    return this.listMountCmd(undefined);
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
      // Capture the ambient operation context so the provider's plain
      // `onOutput` callback (which fires outside this Effect fiber) can
      // emit deltas correlated to THIS exec op. #219: the harness bridges
      // provider streaming → the `sandbox:command:exec` `delta` phase.
      const ctx = yield* getContext;
      const emitOutput = (chunk: SandboxExecDelta): void => {
        Effect.runFork(
          this.emitDeltaLazy(this.execDeltaOp(ctx), () => chunk).pipe(
            Effect.catchAll(() => Effect.void),
          ),
        );
      };
      return yield* Effect.tryPromise<SandboxExecResult, SandboxExecError>({
        try: () =>
          this.handle.exec(input.command, {
            onOutput: emitOutput,
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

  /**
   * Synthesize the exec Operation shell that {@link BaseHarness.emitDeltaLazy}
   * needs to stamp a `delta` envelope onto the in-flight `sandbox:command:exec`
   * op — reconstructed from the captured {@link getContext} because the
   * provider's `onOutput` callback runs outside the command fiber.
   */
  private execDeltaOp(ctx: {
    readonly opId?: string;
    readonly parentOpId?: string;
    readonly sessionId?: string;
    readonly executionId?: string;
    readonly tickId?: string;
  }): Operation<unknown, unknown, unknown> {
    const scope: EventScope = omitUndefined({
      sessionId: ctx.sessionId,
      executionId: ctx.executionId,
      tickId: ctx.tickId,
      sandboxId: this.sandboxId,
    });
    return {
      opId: ctx.opId ?? `sandbox:exec:${this.sandboxId}`,
      surface: "sandbox",
      name: "sandbox:command:exec",
      scope,
      input: undefined,
      ...omitUndefined({ parentOpId: ctx.parentOpId }),
    };
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
    // Delegate to the handle's real `editFile` after the write-permission
    // check. The handle owns edit truth — the layered-matching `applyEdits`
    // transform (crown jewel; `applyEdits` in this base package) plus provider-side atomicity
    // (temp + rename). No more `applyEditsLocal` lite regression.
    return Effect.gen(this, function* () {
      const allowed = yield* this.checkPermission("write", input.path);
      if (!allowed) {
        return yield* Effect.fail(sandboxPermissionDenied("write", input.path, "user-denied"));
      }
      return yield* Effect.tryPromise<SandboxEditResult, SandboxIoError>({
        try: () => this.handle.editFile(input.path, input.edits),
        catch: (cause): SandboxIoError => sandboxIoError(input.path, "edit", "edit failed", cause),
      });
    });
  }

  private addMountBody(input: SandboxAddMountInput): Effect.Effect<void, SandboxError, never> {
    return Effect.gen(this, function* () {
      const addMount = this.handle.addMount;
      if (addMount === undefined) {
        return yield* Effect.fail(new SandboxUnsupportedError({ capability: "addMount" }));
      }
      // Ceiling check: the host path MUST match the construction-time
      // allow-list. Undefined ceiling ⇒ default-deny. The model never
      // reaches this — mounts are not a model-facing tool.
      const hostPath = input.mount.hostPath;
      const allowed = (this.mountAllow ?? []).some((p) => matches(p, hostPath));
      if (!allowed) {
        return yield* Effect.fail(sandboxPermissionDenied("mount", hostPath, "policy"));
      }
      return yield* Effect.tryPromise<void, SandboxMountError>({
        try: () => addMount.call(this.handle, input.mount),
        catch: (cause): SandboxMountError =>
          new SandboxMountError({
            hostPath,
            sandboxPath: input.mount.sandboxPath,
            reason: "add mount failed",
            cause,
          }),
      });
    });
  }

  private removeMountBody(
    input: SandboxRemoveMountInput,
  ): Effect.Effect<void, SandboxError, never> {
    return Effect.gen(this, function* () {
      const removeMount = this.handle.removeMount;
      if (removeMount === undefined) {
        return yield* Effect.fail(new SandboxUnsupportedError({ capability: "removeMount" }));
      }
      return yield* Effect.tryPromise<void, SandboxMountError>({
        try: () => removeMount.call(this.handle, input.sandboxPath),
        catch: (cause): SandboxMountError =>
          new SandboxMountError({
            sandboxPath: input.sandboxPath,
            reason: "remove mount failed",
            cause,
          }),
      });
    });
  }

  private listMountBody(): Effect.Effect<readonly SandboxMount[], SandboxError, never> {
    return Effect.gen(this, function* () {
      const listMounts = this.handle.listMounts;
      if (listMounts === undefined) {
        return yield* Effect.fail(new SandboxUnsupportedError({ capability: "listMounts" }));
      }
      return yield* Effect.tryPromise<readonly SandboxMount[], SandboxMountError>({
        try: () => listMounts.call(this.handle),
        catch: (cause): SandboxMountError =>
          new SandboxMountError({ reason: "list mounts failed", cause }),
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
   * All eight sandbox verbs are declared commands — routed by the
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
