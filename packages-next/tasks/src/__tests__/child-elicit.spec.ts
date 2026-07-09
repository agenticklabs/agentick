/**
 * Cross-process child elicit bridge — REAL fork + IPC (ADR 69 T2b).
 *
 * A forked child task's `ctx.elicit` can't nest-`ask` the parent session
 * directly (a child process has a SEPARATE inbox). The bridge marshals a
 * serializable INTENT `{method, args}` child→parent; the parent
 * reconstructs the LIVE-schema request via the injected sugar
 * (`buildElicit(escalate)`) and escalates it through the EXISTING T1/T2a
 * chain — so validation, ancestor interception, and lineage all apply to
 * a forked task for free. The live `StandardSchemaV1` NEVER crosses IPC.
 *
 * Every test here ACTUALLY forks a `tsx`-loaded fixture worker; the
 * process boundary is real. Two altitudes:
 *
 *   - RAW WIRE (fork the fixture directly, read `WorkerToParentMessage`):
 *     proves the child sends ONLY `{method, args}` (no schema), resolves
 *     on `elicit-response`, flips `input_required → working → completed`
 *     over IPC, and reconstructs a typed error from a serialized
 *     `elicit-error`.
 *   - INTEGRATED (drive a real `TasksHarness` via `fakeTasks` wired with
 *     the real `buildElicitSugar` + a test-registered escalation
 *     terminal): proves the parent reconstruction + escalation round-trip,
 *     the typed-decline path, and the live-schema boundary failing loud.
 *
 * The interception-composes-for-a-forked-child proof needs a real
 * `SessionHarness` terminal and lives in `@agentick/session-next`
 * (`escalation.spec.ts`, T2b) — the package that owns the escalation
 * chain + real sugar.
 */

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Chunk, Effect, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { buildElicitSugar } from "@agentick/elicitation-next";
import type { EscalationEnvelopePayload } from "@agentick/runtime-next";
import { ElicitationDeclined, serializeAgentickError } from "@agentick/spec-next";
import type {
  ElicitationResult,
  ProtocolEvent,
  TaskInfo,
  TaskRecord,
  TaskStatus,
  Unsubscribe,
} from "@agentick/spec-next";
import { drainRejection } from "@agentick/utils-next/testing";
import type { LocalEventBus } from "@agentick/runtime-next";

import { TASK_STATUS_CHANNEL_FQN } from "../channel.js";
import { ChildProcessTaskExecutor } from "../child-executor.js";
import type { WorkerToParentMessage } from "../child-protocol.js";
import { fakeTasks, type FakeTasksBundle } from "../testing/fake-tasks.js";

const WORKER_MODULE = fileURLToPath(new URL("./fixtures/task-worker.ts", import.meta.url));
const FORK_OPTIONS = { execArgv: ["--import", "tsx"] };

function childExecutor(): ChildProcessTaskExecutor {
  return new ChildProcessTaskExecutor({
    workerModule: WORKER_MODULE,
    forkOptions: FORK_OPTIONS,
    killGracePeriodMs: 1_000,
  });
}

function baseRecord(handlerRef: string, taskId: string): TaskRecord {
  const now = 1_700_000_000_000;
  return {
    taskId,
    status: "working",
    scope: {},
    executorKind: "child-process",
    detached: false,
    handlerRef,
    ttl: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Register a test escalation TERMINAL at `session:{id}` — the role a root
 * `SessionHarness` plays. It captures each escalation payload (so tests can
 * assert the LIVE request the parent reconstructed) and returns a canned
 * {@link ElicitationResult} down the ask-return stack.
 */
async function registerTerminal(
  bundle: FakeTasksBundle,
  sessionId: string,
  answer: (payload: EscalationEnvelopePayload) => ElicitationResult,
): Promise<{ readonly requests: EscalationEnvelopePayload[]; readonly unregister: Unsubscribe }> {
  const requests: EscalationEnvelopePayload[] = [];
  const unregister = await Effect.runPromise(
    bundle.inbox.register<EscalationEnvelopePayload, ElicitationResult>(
      `session:${sessionId}`,
      (envelope) => {
        const payload = envelope.payload as EscalationEnvelopePayload;
        requests.push(payload);
        return Effect.succeed(answer(payload));
      },
    ),
  );
  return { requests, unregister };
}

function takeStatusEnvelopes(bus: LocalEventBus, n: number): Promise<readonly ProtocolEvent[]> {
  return Effect.runPromise(
    Stream.runCollect(
      Stream.take(
        bus.subscribe({
          surface: "session",
          name: { exact: TASK_STATUS_CHANNEL_FQN },
        }) as Stream.Stream<ProtocolEvent, unknown, never>,
        n,
      ),
    ),
  ).then((c) => Array.from(Chunk.toReadonlyArray(c)));
}

// ---------------------------------------------------------------------------
// Raw wire — fork the fixture directly, observe WorkerToParentMessage
// ---------------------------------------------------------------------------

describe("child elicit bridge — raw IPC wire (ADR 69 T2b)", () => {
  it("marshals ONLY {method,args} (never the live schema); resolves on elicit-response; FSM flips over IPC", async () => {
    const child = fork(WORKER_MODULE, [], { ...FORK_OPTIONS, silent: true });
    const record = baseRecord("asks-approval", "task:elicit-wire");

    const transitions: Extract<WorkerToParentMessage, { t: "transition" }>["transition"][] = [];
    const elicits: Extract<WorkerToParentMessage, { t: "elicit-request" }>[] = [];
    let onElicit!: (m: Extract<WorkerToParentMessage, { t: "elicit-request" }>) => void;
    const sawElicit = new Promise<Extract<WorkerToParentMessage, { t: "elicit-request" }>>(
      (resolve) => {
        onElicit = resolve;
      },
    );
    let onCompleted!: () => void;
    const sawCompleted = new Promise<void>((resolve) => {
      onCompleted = resolve;
    });
    child.on("message", (message: WorkerToParentMessage) => {
      if (message == null || typeof message !== "object") return;
      if (message.t === "transition") {
        transitions.push(message.transition);
        if (message.transition.status === "completed") onCompleted();
      } else if (message.t === "elicit-request") {
        elicits.push(message);
        onElicit(message);
      }
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });

    await new Promise<void>((resolve) => child.on("spawn", () => resolve()));
    child.send({ t: "start", record });

    const req = await sawElicit;
    // The wire carried the serializable INTENT only — a `confirm("Approve?")`
    // sugar call, NOT the boolean StandardSchemaV1 the sugar builds.
    expect(req.method).toBe("confirm");
    expect(req.args).toEqual(["Approve?"]);
    expect(JSON.stringify(req)).not.toContain("~standard");
    expect(elicits).toHaveLength(1);

    // Answer over IPC → the child's ctx.elicit.confirm resolves true.
    child.send({ t: "elicit-response", requestId: req.requestId, result: true });
    await sawCompleted;
    expect(await exited).toBe(0);

    // The flip crossed IPC (parent writes the initial `working`).
    const statuses = transitions
      .map((t) => t.status)
      .filter((s): s is TaskStatus => s !== undefined);
    expect(statuses).toEqual(["input_required", "working", "completed"]);
    const completed = transitions.find((t) => t.status === "completed");
    expect(completed?.result).toEqual([{ type: "text", text: "approved" }]);
  });

  it("reconstructs a typed error from a serialized elicit-error (ElicitationDeclined round-trips)", async () => {
    const child = fork(WORKER_MODULE, [], { ...FORK_OPTIONS, silent: true });
    const record = baseRecord("asks-approval", "task:elicit-decline-wire");

    const transitions: Extract<WorkerToParentMessage, { t: "transition" }>["transition"][] = [];
    let onElicit!: (m: Extract<WorkerToParentMessage, { t: "elicit-request" }>) => void;
    const sawElicit = new Promise<Extract<WorkerToParentMessage, { t: "elicit-request" }>>(
      (resolve) => {
        onElicit = resolve;
      },
    );
    let onFailed!: () => void;
    const sawFailed = new Promise<void>((resolve) => {
      onFailed = resolve;
    });
    child.on("message", (message: WorkerToParentMessage) => {
      if (message == null || typeof message !== "object") return;
      if (message.t === "transition") {
        transitions.push(message.transition);
        if (message.transition.status === "failed") onFailed();
      } else if (message.t === "elicit-request") {
        onElicit(message);
      }
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });

    await new Promise<void>((resolve) => child.on("spawn", () => resolve()));
    child.send({ t: "start", record });

    const req = await sawElicit;
    // Cross a serialized ElicitationDeclined — the child must revive the
    // exact class (message from its constructor: "user declined: …").
    child.send({
      t: "elicit-error",
      requestId: req.requestId,
      error: { serialized: serializeAgentickError(new ElicitationDeclined({ reason: "nope" })) },
    });
    await sawFailed;
    expect(await exited).toBe(0);

    const failed = transitions.find((t) => t.status === "failed");
    expect(failed?.failure?.reason).toContain("user declined: nope");
  });
});

// ---------------------------------------------------------------------------
// Integrated — real TasksHarness + real sugar + a test escalation terminal
// ---------------------------------------------------------------------------

describe("child elicit bridge — integrated round-trip (ADR 69 T2b)", () => {
  let bundle: FakeTasksBundle | undefined;
  afterEach(async () => {
    if (bundle) await bundle.close();
    bundle = undefined;
  });

  it("a forked child's ctx.elicit.confirm escalates → parent reconstructs the LIVE request → answer + FSM flip round-trip", async () => {
    bundle = await fakeTasks({
      executors: [childExecutor()],
      sessionId: "s-child-approve",
      buildElicit: buildElicitSugar,
    });
    const terminal = await registerTerminal(bundle, "s-child-approve", () => ({
      outcome: "accepted",
      value: true,
    }));

    // working (submit) → input_required (child, over IPC) → working → completed.
    const envsP = takeStatusEnvelopes(bundle.bus, 4);

    const handle = bundle.harness.submit({
      executorKind: "child-process",
      handlerRef: "asks-approval",
    });
    const result = await handle.result;
    expect(result).toEqual([{ type: "text", text: "approved" }]);
    expect(bundle.harness.status(handle.taskId)).toBe("completed");

    // The parent reconstructed the LIVE-schema request (the schema exists
    // on the parent; it never crossed IPC — the child only sent the intent).
    expect(terminal.requests).toHaveLength(1);
    expect(terminal.requests[0]!.class).toBe("elicit");
    const req = terminal.requests[0]!.request as { message: string; schema: unknown };
    expect(req.message).toBe("Approve?");
    expect(req.schema).toBeDefined();
    // Lineage seeded on the parent (origin task + owning session).
    expect(terminal.requests[0]!.lineage?.[0]).toMatchObject({
      scopeId: "session:s-child-approve",
      taskId: handle.taskId,
    });

    const infos = (await envsP).map((e) => e.payload as TaskInfo);
    expect(infos.map((i) => i.status)).toEqual([
      "working",
      "input_required",
      "working",
      "completed",
    ]);
    terminal.unregister();
  });

  it("a terminal decline round-trips as ElicitationDeclined; the child task fails with the decline reason", async () => {
    bundle = await fakeTasks({
      executors: [childExecutor()],
      sessionId: "s-child-decline",
      buildElicit: buildElicitSugar,
    });
    await registerTerminal(bundle, "s-child-decline", () => ({
      outcome: "declined",
      reason: "policy says no",
    }));

    const handle = bundle.harness.submit({
      executorKind: "child-process",
      handlerRef: "asks-text",
    });
    const rejection = await drainRejection(handle.result);
    expect(rejection).toMatchObject({ _tag: "TaskRejection", status: "failed" });
    // The ElicitationDeclined class round-tripped (its constructor stamps
    // "user declined: <reason>") → the child rethrew it → the task failed.
    expect((rejection as { failure?: { reason?: string } }).failure?.reason).toContain(
      "user declined: policy says no",
    );
  });

  it("a live-schema elicit fails LOUD at the boundary (never hangs; never escalates)", async () => {
    bundle = await fakeTasks({
      executors: [childExecutor()],
      sessionId: "s-child-form",
      buildElicit: buildElicitSugar,
    });
    const terminal = await registerTerminal(bundle, "s-child-form", () => ({
      outcome: "accepted",
      value: null,
    }));

    const handle = bundle.harness.submit({
      executorKind: "child-process",
      handlerRef: "elicit-live-schema",
    });
    const rejection = await drainRejection(handle.result);
    expect(rejection).toMatchObject({ _tag: "TaskRejection", status: "failed" });
    expect((rejection as { failure?: { reason?: string } }).failure?.reason).toMatch(
      /live-schema elicit .* can't cross the child-process boundary/,
    );
    // The child failed locally — the escalation never reached the terminal.
    expect(terminal.requests).toHaveLength(0);
    terminal.unregister();
  });
});
