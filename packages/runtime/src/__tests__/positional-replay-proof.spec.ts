/**
 * Positional-replay proof — the ONE load-bearing claim durable code mode rests on.
 *
 * Claim: an operation run under a STABLE (positional) `opId` replays its cached
 * terminal on a re-run — the body executes exactly once — while a random `opId`
 * (the current default) re-executes every time. From that single property the
 * whole durable-execution model follows:
 *
 *   - a re-driven "program" replays its completed steps WITHOUT re-firing their
 *     side effects (no double-charged card, no re-sent email), and
 *   - a step whose answer was committed as its terminal returns that answer
 *     instead of re-executing, while an un-answered step re-executes (re-prompts).
 *
 * This exercises the existing `runOperation` / `lookupTerminal` machinery
 * directly (a shared in-process journal), touching NONE of the loop-executor /
 * session / tasks surfaces. The `bodyRuns` counter is the witness: a replayed op
 * never runs its body, so its count never advances.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import type { MessageEnvelope, MessageHandlerError, Operation } from "@agentick/spec";

import { BaseHarness } from "../substrate/base-harness.js";
import { LocalEventBus } from "../substrate/local-event-bus.js";
import { LocalInbox } from "../substrate/local-inbox.js";
import { MemoryJournal } from "../substrate/memory-journal.js";
import { positionalOpId } from "../substrate/positional-op-id.js";

let randomCounter = 0;

class ReplayProbe extends BaseHarness<"tool"> {
  /** How many times each opId's BODY actually executed (a replay never runs it). */
  readonly bodyRuns = new Map<string, number>();

  constructor() {
    super("tool", "replay-probe", new MemoryJournal(), new LocalEventBus(), new LocalInbox());
  }

  /** Run one op under `opId`; `produce` is the body's effect (recorded on each real run). */
  step<R>(opId: string, produce: () => R): Promise<R> {
    const op: Operation<undefined, R> = {
      opId,
      surface: "tool",
      name: "tool:replay:step",
      scope: { sessionId: "s", executionId: "e", tickId: "t" },
      input: undefined,
    };
    return Effect.runPromise(
      this.runOperation(op, () =>
        Effect.sync(() => {
          this.bodyRuns.set(opId, (this.bodyRuns.get(opId) ?? 0) + 1);
          return produce();
        }),
      ),
    );
  }

  runsOf(opId: string): number {
    return this.bodyRuns.get(opId) ?? 0;
  }

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.succeed(undefined);
  }
}

describe("positional-replay proof", () => {
  it("a stable opId replays the cached terminal — the body runs exactly ONCE across re-runs", async () => {
    const h = new ReplayProbe();
    await h.ready;

    const first = await h.step("prog:step:0", () => "committed-value");
    // Re-run the SAME opId with a body that WOULD produce a different value if it ran:
    const second = await h.step("prog:step:0", () => "should-not-appear");

    expect(first).toBe("committed-value");
    expect(second).toBe("committed-value"); // the cached terminal, not the new body
    expect(h.runsOf("prog:step:0")).toBe(1); // body executed exactly once

    await h.close();
  });

  it("a random opId re-executes every time — no replay (today's default, the blocker)", async () => {
    const h = new ReplayProbe();
    await h.ready;

    await h.step(`op:${++randomCounter}`, () => 1);
    await h.step(`op:${++randomCounter}`, () => 1);

    const totalBodyRuns = [...h.bodyRuns.values()].reduce((a, b) => a + b, 0);
    expect(totalBodyRuns).toBe(2); // two distinct random keys → two executions

    await h.close();
  });

  it("re-driving a program replays completed steps + returns the committed answer, re-executing NOTHING", async () => {
    const h = new ReplayProbe();
    await h.ready;

    // Pass 1 — the program runs two side-effecting steps, then suspends at the ask
    // (the ask's terminal is NOT committed on this pass).
    await h.step("prog:charge", () => "charged"); // side effect A
    await h.step("prog:email", () => "emailed"); // side effect B
    // ...suspend. Nothing is committed for "prog:ask" yet.

    // The answer arrives out-of-band and is committed as the ask op's terminal:
    expect(await h.step("prog:ask", () => "accept")).toBe("accept");
    expect({
      charge: h.runsOf("prog:charge"),
      email: h.runsOf("prog:email"),
      ask: h.runsOf("prog:ask"),
    }).toEqual({ charge: 1, email: 1, ask: 1 });

    // Pass 2 — RE-DRIVE the whole program from the top. Every body would return a
    // sentinel if it ran; none should.
    const charge = await h.step("prog:charge", () => "should-not-recharge");
    const email = await h.step("prog:email", () => "should-not-resend");
    const ask = await h.step("prog:ask", () => "should-not-reprompt");

    expect(charge).toBe("charged"); // replayed
    expect(email).toBe("emailed"); // replayed — no double side effect
    expect(ask).toBe("accept"); // the committed answer, not a re-prompt
    expect(h.runsOf("prog:charge")).toBe(1);
    expect(h.runsOf("prog:email")).toBe(1);
    expect(h.runsOf("prog:ask")).toBe(1);

    await h.close();
  });

  it("without a committed answer, the awaiting step re-executes on re-drive (re-prompts naturally)", async () => {
    const h = new ReplayProbe();
    await h.ready;

    await h.step("prog2:charge", () => "charged");
    // "prog2:ask" was never answered/committed. Re-drive the program:
    await h.step("prog2:charge", () => "x"); // completed step replays
    const prompt = await h.step("prog2:ask", () => "prompt"); // first real run → executes

    expect(prompt).toBe("prompt");
    expect(h.runsOf("prog2:charge")).toBe(1); // replayed
    expect(h.runsOf("prog2:ask")).toBe(1); // executed (re-prompted), not cached

    await h.close();
  });
});

/**
 * The workflow/activity model — the durable-code-mode shape. The "program" is a
 * plain function that re-runs top-to-bottom on re-drive (the *workflow*); its
 * activities are journaled child ops keyed positionally (the *tool bindings*).
 * Re-running the workflow replays every committed activity — side effects fire
 * once even though the code runs twice. (Real code mode auto-parents the child
 * op under the enclosing execute op for causality; replay keys on the child's
 * own opId, so explicit positional keys prove the same property.)
 */
class WorkflowProbe extends BaseHarness<"tool"> {
  readonly activityRuns = new Map<string, number>();
  workflowRuns = 0;

  constructor() {
    super("tool", "workflow-probe", new MemoryJournal(), new LocalEventBus(), new LocalInbox());
  }

  /** One activity — a journaled child op under a positional opId. */
  activity<R>(opId: string, produce: () => R): Promise<R> {
    const op: Operation<undefined, R> = {
      opId,
      surface: "tool",
      name: "tool:replay:activity",
      scope: { sessionId: "s", executionId: "e", tickId: "t" },
      input: undefined,
    };
    return Effect.runPromise(
      this.runOperation(op, () =>
        Effect.sync(() => {
          this.activityRuns.set(opId, (this.activityRuns.get(opId) ?? 0) + 1);
          return produce();
        }),
      ),
    );
  }

  runsOf(opId: string): number {
    return this.activityRuns.get(opId) ?? 0;
  }

  /** The program: pure control flow that re-runs; only its activities memoize. */
  async workflow(suspendAtAsk: boolean): Promise<string> {
    this.workflowRuns += 1;
    const charge = await this.activity("wf:charge", () => "charged");
    const email = await this.activity("wf:email", () => "emailed");
    if (suspendAtAsk) throw new Error("suspend-at-ask");
    const answer = await this.activity("wf:ask", () => "accept");
    return `${charge}|${email}|${answer}`;
  }

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.succeed(undefined);
  }
}

describe("positional-replay proof — nested (workflow re-runs, activities replay)", () => {
  it("durable code mode: the workflow re-runs top-to-bottom while every activity — including the answered ask — replays", async () => {
    const h = new WorkflowProbe();
    await h.ready;

    // Pass 1 — the program runs, commits two side-effecting activities, then
    // suspends at the ask (which never runs on this pass).
    await expect(h.workflow(true)).rejects.toThrow("suspend-at-ask");
    expect(h.runsOf("wf:charge")).toBe(1);
    expect(h.runsOf("wf:email")).toBe(1);
    expect(h.runsOf("wf:ask")).toBe(0);

    // The answer arrives out-of-band and is committed as the ask's terminal:
    expect(await h.activity("wf:ask", () => "accept")).toBe("accept");
    expect(h.runsOf("wf:ask")).toBe(1);

    // Pass 2 — RE-DRIVE: the workflow (the code) re-runs from the top.
    const result = await h.workflow(false);

    expect(result).toBe("charged|emailed|accept");
    expect(h.workflowRuns).toBe(2); // the code genuinely re-ran top-to-bottom
    expect(h.runsOf("wf:charge")).toBe(1); // activity replayed — NOT recharged
    expect(h.runsOf("wf:email")).toBe(1); // NOT re-sent
    expect(h.runsOf("wf:ask")).toBe(1); // committed answer replayed — NOT re-prompted

    await h.close();
  });
});

/**
 * Auto-derived positional keys — the caller supplies NO opId; the key is derived
 * from execution position (`wf:${childIndex}`, reset per workflow run). This
 * proves the derivation SCHEME works for a deterministic re-run — AND that a
 * NON-deterministic re-run misaligns the keys and replays the WRONG terminal.
 * That second property is the whole reason durable execution needs a determinism
 * contract: positional replay is only correct if the re-run issues the same ops
 * in the same order.
 */
class AutoKeyProbe extends BaseHarness<"tool"> {
  readonly bodyRuns = new Map<string, number>();
  private index = 0;

  constructor() {
    super("tool", "auto-key", new MemoryJournal(), new LocalEventBus(), new LocalInbox());
  }

  /** Start (or re-start) a workflow execution — the child counter resets to 0. */
  begin(): void {
    this.index = 0;
  }

  /** The NEXT positional step. The caller supplies no key — it's derived from position. */
  step<R>(produce: () => R): Promise<R> {
    const opId = `wf:${this.index++}`;
    const op: Operation<undefined, R> = {
      opId,
      surface: "tool",
      name: "tool:auto:step",
      scope: { sessionId: "s", executionId: "e", tickId: "t" },
      input: undefined,
    };
    return Effect.runPromise(
      this.runOperation(op, () =>
        Effect.sync(() => {
          this.bodyRuns.set(opId, (this.bodyRuns.get(opId) ?? 0) + 1);
          return produce();
        }),
      ),
    );
  }

  runsOf(opId: string): number {
    return this.bodyRuns.get(opId) ?? 0;
  }

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.succeed(undefined);
  }
}

describe("positional-replay proof — auto-derived keys + the determinism failure mode", () => {
  it("deterministic re-run: position-derived keys replay every step — no hand-supplied keys", async () => {
    const h = new AutoKeyProbe();
    await h.ready;

    // Run 1 — three steps auto-keyed wf:0, wf:1, wf:2.
    h.begin();
    expect(await h.step(() => "charged")).toBe("charged");
    expect(await h.step(() => "emailed")).toBe("emailed");
    expect(await h.step(() => "accept")).toBe("accept");

    // Re-run — SAME order → same auto-keys → every step replays (sentinels never surface).
    h.begin();
    expect(await h.step(() => "should-not-recharge")).toBe("charged");
    expect(await h.step(() => "should-not-resend")).toBe("emailed");
    expect(await h.step(() => "should-not-reprompt")).toBe("accept");

    expect(h.runsOf("wf:0")).toBe(1);
    expect(h.runsOf("wf:1")).toBe(1);
    expect(h.runsOf("wf:2")).toBe(1);

    await h.close();
  });

  it("non-deterministic re-run: an inserted step MISALIGNS the keys → each replays the WRONG terminal", async () => {
    const h = new AutoKeyProbe();
    await h.ready;

    // Run 1 — two committed steps: wf:0 = "charged", wf:1 = "emailed".
    h.begin();
    await h.step(() => "charged");
    await h.step(() => "emailed");

    // Re-run took a DIFFERENT path — an extra step slipped in FIRST, shifting the
    // positional keys by one. The scheme has no way to know this is a new op.
    h.begin();
    const extra = await h.step(() => "extra-fresh-value"); // now wf:0 → charge's terminal
    const charge = await h.step(() => "charged-again"); // now wf:1 → email's terminal

    // CORRUPTION: each step replayed the terminal that belonged to a DIFFERENT op.
    expect(extra).toBe("charged"); // extra got charge's cached value — its body never ran
    expect(charge).toBe("emailed"); // charge got email's cached value
    expect(h.runsOf("wf:0")).toBe(1); // neither new body executed — wrongly replayed
    expect(h.runsOf("wf:1")).toBe(1);

    await h.close();
  });
});

describe("positional-replay proof — explicit injection across an orphan boundary", () => {
  it("an orphan dispatch (fresh fiber, Promise-land, no inherited context) replays when the positional opId is injected explicitly", async () => {
    const h = new ReplayProbe();
    await h.ready;
    const PARENT = "code:exec-42"; // the stable code:execute op id (the logical execution)

    // A "program" running in Promise-land — NO Effect fiber, NO ambient context.
    // Its dispatch closure carries the parent opId + a per-run counter EXPLICITLY
    // (plain data), and each step is its own orphan runOperation. No FiberRef, no ALS.
    const runProgram = async (
      charge: () => string,
      email: () => string,
    ): Promise<readonly string[]> => {
      let index = 0;
      const dispatch = (produce: () => string): Promise<string> =>
        h.step(positionalOpId(PARENT, index++), produce);
      return [await dispatch(charge), await dispatch(email)];
    };

    expect(
      await runProgram(
        () => "charged",
        () => "emailed",
      ),
    ).toEqual(["charged", "emailed"]);
    // Re-run the SAME program (same parent, same order); bodies would return sentinels if they ran:
    expect(
      await runProgram(
        () => "should-not-recharge",
        () => "should-not-resend",
      ),
    ).toEqual(["charged", "emailed"]);

    expect(h.runsOf(positionalOpId(PARENT, 0))).toBe(1); // charge executed once — replayed on re-run
    expect(h.runsOf(positionalOpId(PARENT, 1))).toBe(1); // email once

    await h.close();
  });
});
