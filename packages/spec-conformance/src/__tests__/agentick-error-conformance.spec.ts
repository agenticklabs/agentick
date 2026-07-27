/**
 * Meta-test: run the `runAgentickErrorConformance` suite against the
 * framework's own `@agentick/spec` error registry.
 *
 * Proves every error class shipped by v2 satisfies the invariants
 * pinned in `./errors.ts`. Adding a new error class requires adding
 * a stub row to `EXPECTED` below; the suite then exercises it
 * automatically (registry membership, instance shape, codec round-trip).
 *
 * Lives here (rather than in `@agentick/spec`) to avoid a circular dep
 * between spec and its conformance fixtures.
 */

import "@agentick/spec";
import * as Errors from "@agentick/spec";
import type { AgentickError } from "@agentick/spec";
import { deserializeAgentickError, serializeAgentickError } from "@agentick/spec";
import { describe, expect, it } from "vitest";

import { runAgentickErrorConformance } from "../errors.js";

const EXPECTED: ReadonlyArray<readonly [string, () => AgentickError]> = [
  // Substrate cluster
  ["WriteFailed", () => new Errors.WriteFailed({ cause: new Error("test") })],
  ["ReadFailed", () => new Errors.ReadFailed({ cause: new Error("test") })],
  ["OffsetOutOfRange", () => new Errors.OffsetOutOfRange({ requested: 5, oldest: 10 })],
  ["AddressNotFound", () => new Errors.AddressNotFound({ address: "x:y" })],
  ["RoutingFailed", () => new Errors.RoutingFailed({ cause: new Error("test") })],
  ["InboxClosed", () => new Errors.InboxClosed()],
  ["AskTimeout", () => new Errors.AskTimeout({ timeoutMs: 5000 })],
  ["HandlerError", () => new Errors.HandlerError({ cause: new Error("test") })],
  ["InvalidPayload", () => new Errors.InvalidPayload({ reason: "test" })],
  [
    "LifecycleHandlerError",
    () => new Errors.LifecycleHandlerError({ phase: "before", cause: new Error("test") }),
  ],

  // Lifecycle cluster
  ["SessionNotFoundError", () => new Errors.SessionNotFoundError({ sessionId: "s1" })],
  ["AppClosedError", () => new Errors.AppClosedError()],
  ["AppExecutionFailed", () => new Errors.AppExecutionFailed({ cause: new Error("test") })],
  ["GatewayClosedError", () => new Errors.GatewayClosedError()],
  ["AppAlreadyExistsError", () => new Errors.AppAlreadyExistsError({ appId: "a1" })],
  ["AppNotFoundError", () => new Errors.AppNotFoundError({ appId: "a1" })],
  ["GatewayLifecycleError", () => new Errors.GatewayLifecycleError({ cause: new Error("test") })],
  ["SessionClosedError", () => new Errors.SessionClosedError({ attemptedCommand: "send" })],
  ["SessionBusyError", () => new Errors.SessionBusyError({ reason: "busy" })],
  ["SessionTimelineError", () => new Errors.SessionTimelineError({ reason: "test" })],
  ["KnobError", () => new Errors.KnobError({ knob: "k1", reason: "test" })],
  ["ChannelError", () => new Errors.ChannelError({ channel: "c1", reason: "test" })],
  ["ExecutionFailed", () => new Errors.ExecutionFailed({ cause: new Error("test") })],
  ["TimelineWriteFailed", () => new Errors.TimelineWriteFailed({ cause: new Error("test") })],

  // Execution cluster
  ["ExecutionError", () => new Errors.ExecutionError({ cause: new Error("test") })],
  [
    "TickError",
    () => new Errors.TickError({ tick: 1, phase: "compile", cause: new Error("test") }),
  ],
  ["LoopCanceledError", () => new Errors.LoopCanceledError({ reason: "test" })],
  ["MaxTicksExceeded", () => new Errors.MaxTicksExceeded({ maxTicks: 10 })],
  ["NotMounted", () => new Errors.NotMounted({ mountId: "m1" })],
  ["AlreadyMounted", () => new Errors.AlreadyMounted({ mountId: "m1" })],
  ["RenderFailed", () => new Errors.RenderFailed({ cause: new Error("test") })],
  ["DataFetchFailed", () => new Errors.DataFetchFailed({ key: "k1", cause: new Error("test") })],
  ["MaxIterationsExceeded", () => new Errors.MaxIterationsExceeded({ iterations: 100 })],
  ["UnstableTree", () => new Errors.UnstableTree({ iterations: 100 })],
  ["InvalidElement", () => new Errors.InvalidElement({ reason: "test" })],
  ["SnapshotIncompatible", () => new Errors.SnapshotIncompatible({ specVersion: "2026" })],
  ["BridgeUnavailable", () => new Errors.BridgeUnavailable({ bridge: "b1", hook: "useX" })],
  ["FormatterFailed", () => new Errors.FormatterFailed({ cause: new Error("test") })],
  ["ProviderRejected", () => new Errors.ProviderRejected({ status: 500 })],
  ["ProviderTimeout", () => new Errors.ProviderTimeout({ timeoutMs: 5000 })],
  ["ProviderAborted", () => new Errors.ProviderAborted({ reason: "test" })],
  ["StreamFailed", () => new Errors.StreamFailed({ cause: new Error("test") })],
  ["NormalizationFailed", () => new Errors.NormalizationFailed({ cause: new Error("test") })],
  ["ProjectionFailed", () => new Errors.ProjectionFailed({ reason: "test" })],
  ["Unknown", () => new Errors.UnknownExecutorError({ cause: new Error("test") })],
  ["CompactHandlerFailed", () => new Errors.CompactHandlerFailed({ cause: new Error("test") })],
  ["TimelineHydrateFailed", () => new Errors.TimelineHydrateFailed({ cause: "test" })],

  // Domain harness cluster
  ["ToolNotFoundError", () => new Errors.ToolNotFoundError({ toolName: "t1", registered: ["t2"] })],
  ["ToolValidationError", () => new Errors.ToolValidationError({ toolName: "t1", issues: [] })],
  [
    "ToolHandlerError",
    () => new Errors.ToolHandlerError({ toolName: "t1", cause: new Error("test") }),
  ],
  ["ToolPermissionError", () => new Errors.ToolPermissionError({ toolName: "t1", via: "model" })],
  ["ToolTimeoutError", () => new Errors.ToolTimeoutError({ toolName: "t1", ms: 5000 })],
  ["ToolConfirmationDeniedError", () => new Errors.ToolConfirmationDeniedError({ toolName: "t1" })],
  [
    "ToolConfirmationTimeoutError",
    () => new Errors.ToolConfirmationTimeoutError({ toolName: "t1", ms: 5000 }),
  ],
  ["ToolAbortedError", () => new Errors.ToolAbortedError({ toolCallId: "c1" })],
  ["ToolAlreadyRegistered", () => new Errors.ToolAlreadyRegistered({ toolName: "t1" })],
  [
    "ToolHandlerMissing",
    () => new Errors.ToolHandlerMissing({ toolName: "t1", handlerRef: "h.t1" }),
  ],
  [
    "ToolTaskModeConflictError",
    () =>
      new Errors.ToolTaskModeConflictError({
        toolName: "t1",
        requestedTaskMode: "ref",
        supportMode: "unsupported",
      }),
  ],
  ["PromptNotFound", () => new Errors.PromptNotFound({ promptName: "p1" })],
  ["PromptAlreadyExists", () => new Errors.PromptAlreadyExists({ promptName: "p1" })],
  [
    "PromptArgumentMissing",
    () => new Errors.PromptArgumentMissing({ promptName: "p1", argument: "a1" }),
  ],
  [
    "PromptArgumentInvalid",
    () => new Errors.PromptArgumentInvalid({ promptName: "p1", argument: "a1", issues: [] }),
  ],
  ["PromptMissingContent", () => new Errors.PromptMissingContent({ promptName: "p1" })],
  [
    "PromptRenderFailed",
    () => new Errors.PromptRenderFailed({ promptName: "p1", cause: new Error("test") }),
  ],
  ["PromptsBackendError", () => new Errors.PromptsBackendError({ cause: new Error("test") })],
  ["SkillNotFound", () => new Errors.SkillNotFound({ skillName: "s1" })],
  ["SkillAlreadyExists", () => new Errors.SkillAlreadyExists({ skillName: "s1" })],
  ["SkillsBackendError", () => new Errors.SkillsBackendError({ cause: new Error("test") })],
  ["UnknownKnob", () => new Errors.UnknownKnob({ id: "k1" })],
  ["ValidationFailed", () => new Errors.ValidationFailed({ id: "k1", reason: "test" })],
  ["GroupEmpty", () => new Errors.GroupEmpty({ group: "g1" })],
  ["GroupTypeMismatch", () => new Errors.GroupTypeMismatch({ group: "g1", reason: "test" })],
  ["InvalidDispatchInput", () => new Errors.InvalidDispatchInput({ reason: "test" })],
  ["McpServerNotFound", () => new Errors.McpServerNotFound({ serverName: "server-1" })],
  ["McpServerConfigInvalid", () => new Errors.McpServerConfigInvalid({ reason: "test" })],
  [
    "McpServerTransportFailed",
    () => new Errors.McpServerTransportFailed({ transportKind: "stdio", cause: new Error("test") }),
  ],
  ["McpServerConnectionRejected", () => new Errors.McpServerConnectionRejected({ reason: "test" })],
  ["McpServerAuthRejected", () => new Errors.McpServerAuthRejected({ reason: "test" })],
  ["McpServerAuthzDenied", () => new Errors.McpServerAuthzDenied({ reason: "test" })],
  ["McpServerRateLimited", () => new Errors.McpServerRateLimited({ retryAfterMs: 1000 })],
  ["McpServerClosed", () => new Errors.McpServerClosed({ serverId: "srv-1" })],
  [
    "UrlElicitationRequired",
    () =>
      new Errors.UrlElicitationRequired({
        elicitations: [
          {
            mode: "url",
            elicitationId: "el-1",
            url: "https://example.com/auth",
            message: "Sign in",
          },
        ],
      }),
  ],

  // Elicit cluster
  ["ElicitationDeclined", () => new Errors.ElicitationDeclined()],
  ["ElicitationCancelled", () => new Errors.ElicitationCancelled()],
  ["ElicitationNotSupported", () => new Errors.ElicitationNotSupported({ mode: "form" })],

  // Remaining cluster
  ["UnknownTaskError", () => new Errors.UnknownTaskError({ taskId: "task-1" })],
  ["ChannelPublisherClosed", () => new Errors.ChannelPublisherClosed()],
  ["ChannelSequenceOverflow", () => new Errors.ChannelSequenceOverflow({ channel: "c1" })],
  ["SandboxExecError", () => new Errors.SandboxExecError({ command: "ls", exitCode: 1 })],
  [
    "SandboxIoError",
    () => new Errors.SandboxIoError({ path: "/tmp/x", op: "read", reason: "test" }),
  ],
  ["SandboxMountError", () => new Errors.SandboxMountError({ reason: "test" })],
  [
    "SandboxEscapeError",
    () => new Errors.SandboxEscapeError({ kind: "path-traversal", target: "/etc/passwd" }),
  ],
  [
    "SandboxResourceLimitError",
    () => new Errors.SandboxResourceLimitError({ kind: "memory", observedValue: 1024, limit: 512 }),
  ],
  [
    "SandboxPermissionDeniedError",
    () => new Errors.SandboxPermissionDeniedError({ kind: "exec", target: "/bin/sh" }),
  ],
  ["SandboxConnectionError", () => new Errors.SandboxConnectionError({ reason: "test" })],
  [
    "McpClientNotReadyError",
    () => new Errors.McpClientNotReadyError({ state: "idle", serverId: "srv-1" }),
  ],
  [
    "McpTransportError",
    () => new Errors.McpTransportError({ serverId: "srv-1", cause: new Error("test") }),
  ],
  [
    "McpRemoteTaskNonCompletedError",
    () => new Errors.McpRemoteTaskNonCompletedError({ taskId: "task-1", status: "failed" }),
  ],
];

const tagStubs = new Map<string, () => AgentickError>(EXPECTED);

runAgentickErrorConformance({
  expectedTags: EXPECTED.map(([tag]) => tag),
  instantiate(tag) {
    const stub = tagStubs.get(tag);
    return stub ? stub() : null;
  },
});

/**
 * Regression pins for the harness-error domain-field rename. Before the
 * rename these fourteen classes declared their domain value (tool /
 * prompt / gate / skill / server name) on `readonly name` — squatting the
 * platform `Error.name` slot. Two invariants broke as a result and are
 * pinned here for one class per family:
 *
 *   1. **Wire fidelity.** `Error.name` is skipped by `toJSON()` (it's an
 *      Error-inherited slot), so a domain value parked on `name` was
 *      DROPPED over every wire. The renamed field must survive a
 *      serialize → deserialize round-trip alongside `_tag` + `message`.
 *   2. **Platform slot.** `e.name` must be the CLASS name (stamped by the
 *      `AgentickError` base ctor), never the domain value — on both the
 *      original and the round-tripped instance.
 */
describe("harness-error domain field (rename regression)", () => {
  const CASES = [
    {
      className: "GateNotFound",
      make: () => new Errors.GateNotFound({ gateName: "deploy" }),
      field: "gateName",
      value: "deploy",
    },
    {
      className: "SkillNotFound",
      make: () => new Errors.SkillNotFound({ skillName: "reviewer" }),
      field: "skillName",
      value: "reviewer",
    },
    {
      className: "ToolNotFoundError",
      make: () => new Errors.ToolNotFoundError({ toolName: "calc.add", registered: ["calc.sub"] }),
      field: "toolName",
      value: "calc.add",
    },
    {
      className: "PromptNotFound",
      make: () => new Errors.PromptNotFound({ promptName: "greeting" }),
      field: "promptName",
      value: "greeting",
    },
    {
      className: "McpServerNotFound",
      make: () => new Errors.McpServerNotFound({ serverName: "filesystem" }),
      field: "serverName",
      value: "filesystem",
    },
  ] as const;

  for (const { className, make, field, value } of CASES) {
    it(`${className}: preserves the domain field, _tag, and message across a wire round-trip`, () => {
      const original = make();
      const restored = deserializeAgentickError(serializeAgentickError(original));

      // Wire fidelity — the domain value survives (it was silently dropped
      // when parked on the `name` slot, which `toJSON` skips).
      expect((restored as unknown as Record<string, unknown>)[field]).toBe(value);
      expect((original as unknown as Record<string, unknown>)[field]).toBe(value);
      expect(restored._tag).toBe(className);
      expect(restored.message).toBe(original.message);
    });

    it(`${className}: keeps the platform \`name\` slot pinned to the class name, not the domain value`, () => {
      const original = make();
      const restored = deserializeAgentickError(serializeAgentickError(original));

      expect(original.name).toBe(className);
      expect(restored.name).toBe(className);
      expect(original.name).not.toBe(value);
    });
  }
});
