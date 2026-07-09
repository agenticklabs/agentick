/**
 * Request escalation — origin-side guards (ADR 69 T1).
 *
 * The full round-trip (task → owning session → terminal client elicit →
 * answer threads back) is a CROSS-HARNESS test and lives in
 * `@agentick/session-next` (which owns both the real `SessionHarness`
 * terminal AND the `TasksHarness`). Here we prove the tasks-owned edges
 * of the seam in isolation:
 *
 *   - `interactive ⊥ detached`: `ctx.awaitingInput` (and therefore
 *     `ctx.elicit`, which composes over it) on a `detached: true` task
 *     raises the typed `DetachedTaskCannotElicitError` — the task fails
 *     loud, it does NOT hang.
 *   - a harness with no escalation wiring (`buildElicit` absent — a bare
 *     `TasksHarness`, not a session-owned one) exposes a `ctx.elicit`
 *     that throws a clear "not configured" error on use, never a silent
 *     hang against a client that isn't there.
 *
 * The recursive `parentSessionId` forward hop, ancestor interception, and
 * `lineage` provenance are proven in `@agentick/session-next`'s
 * `escalation.spec.ts` (T2a). TODO(ADR-69 T2b): the cross-process
 * (child-executor) elicit bridge over IPC.
 */

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { buildElicitSugar } from "@agentick/elicitation-next";
import { DetachedTaskCannotElicitError } from "@agentick/spec-next";
import type { ElicitationResult, Unsubscribe } from "@agentick/spec-next";
import type { EscalationEnvelopePayload } from "@agentick/runtime-next";
import { drainRejection } from "@agentick/utils-next/testing";

import { fakeTasks, type FakeTasksBundle } from "../testing/fake-tasks.js";

/** Register a terminal escalation handler at `session:{sessionId}` that records
 *  the requests it receives and answers with a canned result. */
async function registerTerminal(
  bundle: FakeTasksBundle,
  sessionId: string,
  answer: ElicitationResult,
): Promise<{ readonly requests: EscalationEnvelopePayload[]; readonly unregister: Unsubscribe }> {
  const requests: EscalationEnvelopePayload[] = [];
  const unregister = await Effect.runPromise(
    bundle.inbox.register<EscalationEnvelopePayload, ElicitationResult>(
      `session:${sessionId}`,
      (envelope) => {
        requests.push(envelope.payload as EscalationEnvelopePayload);
        return Effect.succeed(answer);
      },
    ),
  );
  return { requests, unregister };
}

describe("TasksHarness — escalation origin guards (ADR 69)", () => {
  let bundle: FakeTasksBundle | undefined;
  afterEach(async () => {
    if (bundle) await bundle.close();
    bundle = undefined;
  });

  it("awaitingInput on a detached task throws DetachedTaskCannotElicitError (interactive ⊥ detached) — the task fails, does not hang", async () => {
    bundle = await fakeTasks({ sessionId: "s-detached" });

    const handle = bundle.harness.submit(
      async (ctx) => {
        // A detached task cannot pause on client input — this must throw,
        // never await a promise that would strand the task.
        await ctx.awaitingInput(new Promise<string>(() => {}), { message: "need input" });
        return [{ type: "text", text: "unreachable" }];
      },
      { detached: true },
    );

    const rejection = await drainRejection(handle.result);
    expect(rejection).toMatchObject({ _tag: "TaskRejection", status: "failed" });
    const cause = (rejection as { failure?: { cause?: unknown } }).failure?.cause;
    expect(cause).toBeInstanceOf(DetachedTaskCannotElicitError);
    expect((cause as DetachedTaskCannotElicitError).taskId).toBe(handle.taskId);
    // Terminal — not stranded in input_required.
    expect(bundle.harness.status(handle.taskId)).toBe("failed");
  });

  it("ctx.elicit on a harness with no escalation wiring throws a clear 'not configured' error", async () => {
    // fakeTasks constructs a bare TasksHarness — no `buildElicit`, so
    // `ctx.elicit` is the throwing stub (no client to reach).
    bundle = await fakeTasks({ sessionId: "s-unwired" });

    const handle = bundle.harness.submit(async (ctx) => {
      const answer = await ctx.elicit.text("Approve?");
      return [{ type: "text", text: answer }];
    });

    const rejection = await drainRejection(handle.result);
    expect(rejection).toMatchObject({ _tag: "TaskRejection", status: "failed" });
    expect((rejection as { failure?: { reason?: string } }).failure?.reason).toMatch(
      /not configured/i,
    );
  });

  it("capability probes on the unconfigured ctx.elicit report false rather than throw", async () => {
    bundle = await fakeTasks({ sessionId: "s-probe" });
    let probedForm: boolean | undefined;
    let probedUrl: boolean | undefined;

    const handle = bundle.harness.submit(async (ctx) => {
      probedForm = ctx.elicit.canDoForm();
      probedUrl = ctx.elicit.canDoUrl();
      return [{ type: "text", text: "done" }];
    });

    await handle.result;
    expect(probedForm).toBe(false);
    expect(probedUrl).toBe(false);
  });
});

describe("TasksHarness — escalation routes per ORIGINATING session (app-scoped fan-in)", () => {
  let bundle: FakeTasksBundle | undefined;
  afterEach(async () => {
    if (bundle) await bundle.close();
    bundle = undefined;
  });

  it("ONE harness serving many sessions escalates each task's ctx.elicit to that task's own owning session (record.scope, not harness scope)", async () => {
    // A shared harness — NO harness sessionId (this.scope = {}). Each task
    // carries its originating session via the per-submit `scope`.
    bundle = await fakeTasks({ buildElicit: buildElicitSugar });
    const a = await registerTerminal(bundle, "sess-A", { outcome: "accepted", value: true });
    const b = await registerTerminal(bundle, "sess-B", { outcome: "accepted", value: false });

    const hA = bundle.harness.submit(
      async (ctx) => [{ type: "text", text: (await ctx.elicit.confirm("A?")) ? "A-yes" : "A-no" }],
      { scope: { sessionId: "sess-A" } },
    );
    const hB = bundle.harness.submit(
      async (ctx) => [{ type: "text", text: (await ctx.elicit.confirm("B?")) ? "B-yes" : "B-no" }],
      { scope: { sessionId: "sess-B" } },
    );

    expect(await hA.result).toEqual([{ type: "text", text: "A-yes" }]);
    expect(await hB.result).toEqual([{ type: "text", text: "B-no" }]);

    // Each escalation reached ONLY its originating session's terminal, and the
    // lineage origin is stamped from the record's scope — not the harness's.
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(1);
    expect(a.requests[0]!.lineage?.[0]).toMatchObject({
      scopeId: "session:sess-A",
      taskId: hA.taskId,
    });
    expect(b.requests[0]!.lineage?.[0]).toMatchObject({
      scopeId: "session:sess-B",
      taskId: hB.taskId,
    });

    a.unregister();
    b.unregister();
  });
});
