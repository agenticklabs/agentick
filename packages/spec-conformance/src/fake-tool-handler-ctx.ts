/**
 * `fakeToolHandlerCtx()` — shared factory for in-test
 * `ToolHandlerCtx` fakes. Replaces ad-hoc fixtures scattered across
 * `@agentick/tool/__tests__`, `@agentick/compiler-react/__tests__`, etc.
 *
 * Why centralized: when the canonical `ToolHandlerCtx` shape evolves
 * (new required fields, new sugar slots), one update here propagates
 * to every consumer's tests. ADR 43 Slice 1 added the `transport`
 * discriminator + `mcp?` extras; without a shared factory the
 * required-field addition would have broken every spec independently.
 *
 * @see docs/proposals/v2/blueprint/43-unified-tool-handler-ctx.md
 */

import { createLog } from "@agentick/spec";
import type {
  Elicit,
  ElicitationHarnessProtocol,
  McpRequestExtras,
  Metrics,
  Span,
  TasksHarnessProtocol,
  ToolHandlerCtx,
} from "@agentick/spec";

export interface FakeToolHandlerCtxOverrides {
  readonly toolCallId?: string;
  readonly sessionId?: string;
  readonly executionId?: string;
  readonly tickId?: string;
  readonly signal?: AbortSignal;
  readonly task?: "auto" | "ref" | "inline";
  readonly transport?: "in-process" | "mcp";
  readonly mcp?: Partial<McpRequestExtras>;
  readonly elicit?: Elicit;
  readonly elicitation?: ElicitationHarnessProtocol;
  readonly tasks?: TasksHarnessProtocol;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly setState?: (key: string, value: unknown) => void;
  readonly emit?: ToolHandlerCtx["emit"];
  readonly log?: ToolHandlerCtx["log"];
  readonly progress?: ToolHandlerCtx["progress"];
  readonly trace?: ToolHandlerCtx["trace"];
  readonly metrics?: ToolHandlerCtx["metrics"];
  readonly run?: ToolHandlerCtx["run"];
  readonly runner?: ToolHandlerCtx["runner"];
}

/** No-op {@link Span} for the off-path fake `trace`. */
const NOOP_FAKE_SPAN: Span = {
  setAttribute: () => {},
  setAttributes: () => {},
  addEvent: () => {},
  recordException: () => {},
};

/** No-op {@link Metrics} default for the fake ctx (override to spy). */
const NOOP_FAKE_METRICS: Metrics = {
  count: () => {},
  record: () => {},
  gauge: () => {},
};

/**
 * Fake {@link Ops.run} — runs `fn` and resolves with its value, skipping the
 * journal/interceptor pipeline (a test double, not the real substrate).
 */
const fakeRun = (<T>(
  name: string,
  optsOrFn: unknown,
  maybeFn?: () => T | Promise<T>,
): Promise<T> => {
  const fn = (typeof optsOrFn === "function" ? optsOrFn : maybeFn) as () => T | Promise<T>;
  return Promise.resolve(fn());
}) as ToolHandlerCtx["run"];

/** Fake {@link OperationRunnerView} — runs the body directly, no journaling. */
const fakeRunner: ToolHandlerCtx["runner"] = {
  runOperation: (op, body) => body(op.input) as never,
};

/**
 * Build a fake `ToolHandlerCtx` for test code. Defaults to a minimal
 * in-process shape with all optional substrate primitives left
 * undefined. Pass `transport: "mcp"` + `mcp: {...}` overrides for
 * MCP-side fixtures; the resulting ctx is structurally identical to
 * `McpRequestContext` (per ADR 43, that's a type alias of
 * `ToolHandlerCtx & { transport: "mcp"; mcp: McpRequestExtras }`).
 *
 * The `setState` / `emit` defaults are no-ops; override to spy in
 * tests that care.
 */
export function fakeToolHandlerCtx(overrides: FakeToolHandlerCtxOverrides = {}): ToolHandlerCtx {
  const transport = overrides.transport ?? "in-process";
  const base: Omit<ToolHandlerCtx, "mcp"> = {
    toolCallId: overrides.toolCallId ?? "tc:test",
    signal: overrides.signal ?? new AbortController().signal,
    setState: overrides.setState ?? (() => {}),
    emit: overrides.emit ?? (() => {}),
    // ADR 64 — universal signal slots; no-op defaults (override to spy).
    // `log` is the callable {@link Log} (level methods + `.with`); the default
    // wraps a no-op emit.
    log: overrides.log ?? createLog(() => {}),
    progress: overrides.progress ?? (() => {}),
    // ADR 78 — Observability facet's telemetry half; off-path no-ops.
    trace: overrides.trace ?? ((_name, fn) => Promise.resolve(fn(NOOP_FAKE_SPAN))),
    metrics: overrides.metrics ?? NOOP_FAKE_METRICS,
    // ADR 19/83 — Ops facet; fake run/runner execute without journaling.
    run: overrides.run ?? fakeRun,
    runner: overrides.runner ?? fakeRunner,
    task: overrides.task ?? "auto",
    transport,
    ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
    ...(overrides.executionId !== undefined ? { executionId: overrides.executionId } : {}),
    ...(overrides.tickId !== undefined ? { tickId: overrides.tickId } : {}),
    ...(overrides.elicit !== undefined ? { elicit: overrides.elicit } : {}),
    ...(overrides.elicitation !== undefined ? { elicitation: overrides.elicitation } : {}),
    ...(overrides.tasks !== undefined ? { tasks: overrides.tasks } : {}),
    ...(overrides.metadata !== undefined ? { metadata: overrides.metadata } : {}),
  };
  if (transport === "mcp") {
    return {
      ...base,
      mcp: {
        serverId: "srv:test",
        connectionId: "conn:test",
        transportKind: "in-memory",
        connectedAt: 0,
        user: null,
        clientInfo: null,
        clientCapabilities: null,
        ...(overrides.mcp ?? {}),
      },
    };
  }
  return base;
}
