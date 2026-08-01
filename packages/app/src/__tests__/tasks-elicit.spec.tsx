/**
 * A background task reaches the SESSION's client through real `createApp`
 * wiring — `ctx.elicit`, end to end (ADR 69).
 *
 * `buildSessionBridges` injects `buildElicit` only on the harness IT
 * constructs; every `createApp` composition INJECTS its own `TasksHarness`
 * (the single-construction-site rule, #159), so that fallback arm never runs
 * and the app-built harness shipped without the factory. `buildTaskElicit`
 * then returned the throwing stub and the FIRST `ctx.elicit.*` call in any
 * app-composed session failed the task with "ctx.elicit is not configured".
 * Only a test that goes through `createApp` can see that — the session-level
 * escalation spec builds its harness the other way, so it was green
 * throughout. Twin of `prompts-invoke-elicit.spec.tsx` (same class of bug: a
 * facet wired at one construction site and not the other).
 *
 * Pins:
 *  - a task's `ctx.elicit.text` round-trips through the session's real
 *    `ElicitationHarness` and the answer resolves the work fn;
 *  - `canDoForm()` reports the live capability (`true`), not the stub's `false`;
 *  - `interactive ⊥ detached` STILL holds on the live path — with the factory
 *    injected, `assertInteractive` is the guard that actually runs (before it
 *    was unreachable behind the not-configured stub).
 *
 * @see packages/app/src/harness.ts (the `buildElicit: buildElicitSugar` injection)
 * @see packages/session/src/__tests__/escalation.spec.ts (the escalation chain itself)
 */

import React from "react";
import { describe, expect, it } from "vitest";
import type { ElicitationHarness, ElicitationSnapshotFrame } from "@agentick/elicitation";
import type { ContentBlock, SessionHarnessProtocol } from "@agentick/spec";
import { DetachedTaskCannotElicitError } from "@agentick/spec";
import { drainRejection, waitFor } from "@agentick/utils/testing";

import { createApp } from "../react.js";

const Agent = (): React.ReactElement =>
  React.createElement("message", { role: "system" }, "task host");

/**
 * Answer the one ask outstanding on the session, the way a client does: read
 * the pending request off the elicitation channel's snapshot frame, then
 * `respond` with its correlationId. (Same shape as
 * `prompts-invoke-elicit.spec.tsx`; the ask arrives here by ESCALATION.)
 */
async function answerPendingAsk(
  session: SessionHarnessProtocol<unknown>,
  value: string,
): Promise<string> {
  const harness = session.elicitation as ElicitationHarness;
  await waitFor(() => harness.pendingCount() === 1, { description: "an ask to be raised" });
  const frame = (await session.channelSnapshot("elicitation"))?.payload as ElicitationSnapshotFrame;
  const request = frame.requests[0]!;
  await harness.respond({ correlationId: request.correlationId, outcome: "accepted", value });
  return (request.payload as { message: string }).message;
}

describe("createApp → task ctx.elicit", () => {
  it("a task's ctx.elicit.text escalates to the session's client and the answer resolves the work fn", async () => {
    const app = await createApp(React.createElement(Agent), {});
    const session = await app.createSession({ sessionId: "s-task-elicit" });

    let canDoForm: boolean | undefined;
    const handle = session.tasks.submit<readonly ContentBlock[]>(async (ctx) => {
      canDoForm = ctx.elicit.canDoForm();
      return [{ type: "text", text: await ctx.elicit.text("Approve?") }];
    });

    const asked = await answerPendingAsk(session, "approved");
    const result = await handle.result;

    // The task's own question reached the client, verbatim, and the client's
    // answer threaded back down the escalation ask stack.
    expect(asked).toBe("Approve?");
    expect(result).toEqual([{ type: "text", text: "approved" }]);
    expect(session.tasks.status(handle.taskId)).toBe("completed");
    // The live sugar, not the stub — the stub's probe reports `false`.
    expect(canDoForm).toBe(true);

    await session.close();
    await app.close();
  });

  it("interactive ⊥ detached: a detached task's ctx.elicit throws DetachedTaskCannotElicitError and raises no ask", async () => {
    // THE assertion most at risk from the fix: `assertInteractive` used to sit
    // behind the not-configured stub (which threw first, for the wrong
    // reason). With `buildElicit` injected it is the guard that runs — and it
    // must still fire BEFORE any escalation leaves the task.
    const app = await createApp(React.createElement(Agent), {});
    const session = await app.createSession({ sessionId: "s-task-elicit-detached" });

    const handle = session.tasks.submit<readonly ContentBlock[]>(
      async (ctx) => [{ type: "text", text: await ctx.elicit.text("Approve?") }],
      { detached: true },
    );

    const rejection = await drainRejection(handle.result);
    expect(rejection).toMatchObject({ _tag: "TaskRejection", status: "failed" });
    const cause = (rejection as { failure?: { cause?: unknown } }).failure?.cause;
    expect(cause).toBeInstanceOf(DetachedTaskCannotElicitError);
    // No orphaned ask was left in flight.
    expect((session.elicitation as ElicitationHarness).pendingCount()).toBe(0);

    await session.close();
    await app.close();
  });
});
